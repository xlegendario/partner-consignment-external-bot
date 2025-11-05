// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // --- TABLES
  AIRTABLE_TABLE_INVENTORY  = "Inventory",
  AIRTABLE_TABLE_OFFER_MSGS = "Offer Messages",
  AIRTABLE_TABLE_EXTERNAL   = "External Sales Log",

  // --- INVENTORY FIELDS
  FIELD_INV_QTY               = "Quantity",
  FIELD_INV_PRODUCT_NAME      = "Master Product Name",
  FIELD_INV_SIZE              = "Size EU",
  FIELD_INV_BRAND             = "Brand",
  FIELD_INV_VAT_TYPE          = "VAT Type (Margin / VAT0 / VAT21)",
  FIELD_INV_LINK_SKU_MASTER   = "SKU Master",
  FIELD_INV_LINKED_SELLER     = "Linked Seller",

  // --- OFFER MSG FIELDS
  FIELD_OFFERS_ORDER_ID       = "Order Record ID",
  FIELD_OFFERS_CHANNEL_ID     = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID     = "Message ID",
  FIELD_OFFERS_SELLER_ID,
  FIELD_OFFERS_INV_ID,
  FIELD_OFFERS_OFFER_PRICE,

  // --- EXTERNAL (confirmation write targets)
  FIELD_OFFER_STATUS          = "Offer Status",
  FIELD_CONFIRMED_PRICE       = "Confirmed Offer Price",
  FIELD_CONFIRMED_SELLER      = "Confirmed Seller", // linked to Sellers Database
} = process.env;

const AT_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

/* core request */
async function airtableRequest(method, path, body) {
  const res = await fetch(`${AT_API}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`[Airtable] ${method} ${path} → ${res.status} ${txt}`);
  }
  return res.json();
}

/* helpers */
const toText = (val) => {
  if (!val) return null;
  if (Array.isArray(val)) {
    const parts = val
      .map((x) => typeof x === "string" ? x : (x && typeof x.name === "string" ? x.name : null))
      .filter(Boolean);
    return parts.join(", ") || null;
  }
  if (typeof val === "object" && val.name) return val.name;
  if (typeof val === "string") return val.trim();
  if (typeof val === "number") return String(val);
  return null;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Return first linked rec id if the cell is ["rec..."] or [{id:"rec..."}]
const getFirstLinkedId = (val) => {
  if (!Array.isArray(val) || !val.length) return null;
  const first = val[0];
  if (typeof first === "string") return first;
  if (first && typeof first.id === "string") return first.id;
  return null;
};

function uniqBy(arr, keyer) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyer(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

/* -------------------- Offer Messages log/read (unchanged) -------------------- */
export async function logOfferMessage({ orderRecId, sellerId, inventoryRecordId, channelId, messageId, offerPrice }) {
  try {
    const fields = {
      [FIELD_OFFERS_ORDER_ID]: orderRecId,
      [FIELD_OFFERS_CHANNEL_ID]: channelId,
      [FIELD_OFFERS_MESSAGE_ID]: messageId,
    };
    if (FIELD_OFFERS_SELLER_ID) fields[FIELD_OFFERS_SELLER_ID] = sellerId ?? null;
    if (FIELD_OFFERS_INV_ID)    fields[FIELD_OFFERS_INV_ID]    = inventoryRecordId ?? null;
    if (FIELD_OFFERS_OFFER_PRICE)
      fields[FIELD_OFFERS_OFFER_PRICE] =
        typeof offerPrice === "number" ? round2(offerPrice) : null;

    await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS), { fields });
  } catch (e) {
    console.warn("logOfferMessage warn:", e.message);
  }
}

export async function listOfferMessagesForOrder(orderRecId) {
  if (!orderRecId) return [];
  const tablePath = encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS);
  const formula = `{${FIELD_OFFERS_ORDER_ID}}='${orderRecId}'`;
  const data = await airtableRequest("GET", `${tablePath}?filterByFormula=${encodeURIComponent(formula)}`);
  const pairs = (data.records || [])
    .map(r => ({
      channelId: r.fields?.[FIELD_OFFERS_CHANNEL_ID],
      messageId: r.fields?.[FIELD_OFFERS_MESSAGE_ID],
    }))
    .filter(x => x.channelId && x.messageId);
  return uniqBy(pairs, p => `${p.channelId}:${p.messageId}`);
}

/* -------------------- NEW helpers for External confirmation -------------------- */

/** Read Inventory -> return linked Seller record id (recXXXXXXXX) */
export async function getInventoryLinkedSellerId(inventoryId) {
  const inv = await airtableRequest(
    "GET",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`
  );
  const f = inv.fields || {};
  const sellerLinkId = getFirstLinkedId(f[FIELD_INV_LINKED_SELLER]);
  if (!sellerLinkId) {
    throw new Error(`Inventory ${inventoryId}: Linked Seller field empty or not a linked record.`);
  }
  return sellerLinkId;
}

/**
 * Patch External Sales Log record with:
 * - Offer Status = statusName (default "Confirmed")
 * - Confirmed Offer Price = confirmedPrice
 * - Confirmed Seller = [seller rec id]
 */
export async function setExternalConfirmation({
  orderRecId,
  confirmedPrice,
  confirmedSellerRecId,
  statusName = "Confirmed",
}) {
  const tableName = AIRTABLE_TABLE_EXTERNAL;
  const recUrl = `${encodeURIComponent(tableName)}/${orderRecId}`;
  const fields = {};

  // Offer Status (single select) with dual write
  try {
    fields[FIELD_OFFER_STATUS || "Offer Status"] = { name: statusName };
    // Include other fields as well in this PATCH
    fields[FIELD_CONFIRMED_PRICE || "Confirmed Offer Price"] =
      typeof confirmedPrice === "number" ? round2(confirmedPrice) : null;
    fields[FIELD_CONFIRMED_SELLER || "Confirmed Seller"] =
      confirmedSellerRecId ? [confirmedSellerRecId] : [];
    await airtableRequest("PATCH", recUrl, { fields });
  } catch {
    // fallback: plain string single-select write
    fields[FIELD_OFFER_STATUS || "Offer Status"] = statusName;
    await airtableRequest("PATCH", recUrl, { fields });
  }
}
