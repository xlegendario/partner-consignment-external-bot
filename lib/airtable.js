// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  AIRTABLE_TABLE_INVENTORY  = "Inventory",
  AIRTABLE_TABLE_OFFER_MSGS = "Offer Messages",
  AIRTABLE_TABLE_EXTERNAL   = "External Sales Log",

  FIELD_INV_LINKED_SELLER   = "Linked Seller",

  FIELD_OFFERS_ORDER_ID     = "Order Record ID",
  FIELD_OFFERS_CHANNEL_ID   = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID   = "Message ID",
  FIELD_OFFERS_SELLER_ID,
  FIELD_OFFERS_INV_ID,
  FIELD_OFFERS_OFFER_PRICE,

  FIELD_OFFER_STATUS        = "Offer Status",
  FIELD_CONFIRMED_PRICE     = "Confirmed Offer Price",
  FIELD_CONFIRMED_SELLER    = "Confirmed Seller",
  FIELD_OFFER_VAT_TYPE      = "Offer VAT Type",   // 👈 new: single select with options Margin / VAT0 / VAT21
} = process.env;

const AT_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

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

const toText = (val) => {
  if (!val) return null;
  if (Array.isArray(val)) {
    const parts = val.map(x => typeof x === "string" ? x : (x?.name ?? null)).filter(Boolean);
    return parts.join(", ") || null;
  }
  if (typeof val === "object" && val.name) return val.name;
  if (typeof val === "string") return val.trim();
  if (typeof val === "number") return String(val);
  return null;
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const getFirstLinkedId = (val) => (Array.isArray(val) && val[0])
  ? (typeof val[0] === "string" ? val[0] : val[0].id)
  : null;

/* Offer log (unchanged) */
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
      fields[FIELD_OFFERS_OFFER_PRICE] = typeof offerPrice === "number" ? round2(offerPrice) : null;
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
  return (data.records || [])
    .map(r => ({ channelId: r.fields?.[FIELD_OFFERS_CHANNEL_ID], messageId: r.fields?.[FIELD_OFFERS_MESSAGE_ID] }))
    .filter(x => x.channelId && x.messageId);
}

/* --- Helpers for confirmation write --- */
export async function getInventoryLinkedSellerId(inventoryId) {
  const rec = await airtableRequest("GET", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`);
  const id = getFirstLinkedId(rec.fields?.[FIELD_INV_LINKED_SELLER]);
  if (!id) throw new Error(`Inventory ${inventoryId}: Linked Seller is empty.`);
  return id;
}

/* Write: Status, Confirmed Price, Confirmed Seller, Offer VAT Type */
export async function setExternalConfirmation({
  orderRecId,
  confirmedPrice,
  confirmedSellerRecId,
  statusName = "Confirmed",
  offerVatTypeLabel, // "Margin" | "VAT0" | "VAT21"
}) {
  const recUrl = `${encodeURIComponent(AIRTABLE_TABLE_EXTERNAL)}/${orderRecId}`;
  const fields = {};

  // Always write price & seller
  fields[FIELD_CONFIRMED_PRICE || "Confirmed Offer Price"] =
    typeof confirmedPrice === "number" ? round2(confirmedPrice) : null;
  fields[FIELD_CONFIRMED_SELLER || "Confirmed Seller"] =
    confirmedSellerRecId ? [confirmedSellerRecId] : [];

  // Offer Status single-select (object form, fallback to string)
  try {
    fields[FIELD_OFFER_STATUS || "Offer Status"] = { name: statusName };
    if (offerVatTypeLabel) fields[FIELD_OFFER_VAT_TYPE || "Offer VAT Type"] = { name: offerVatTypeLabel };
    await airtableRequest("PATCH", recUrl, { fields });
  } catch {
    fields[FIELD_OFFER_STATUS || "Offer Status"] = statusName;
    if (offerVatTypeLabel) fields[FIELD_OFFER_VAT_TYPE || "Offer VAT Type"] = offerVatTypeLabel;
    await airtableRequest("PATCH", recUrl, { fields });
  }
}
