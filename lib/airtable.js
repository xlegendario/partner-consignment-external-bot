// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // --- TABLES
  AIRTABLE_TABLE_INVENTORY  = "Inventory",
  AIRTABLE_TABLE_SALES      = "Sales",
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

  // --- SALES FIELDS
  FIELD_SALE_PRODUCT_NAME     = "Product Name",
  FIELD_SALE_SKU_LINK         = "SKU",
  FIELD_SALE_SIZE             = "Size",
  FIELD_SALE_BRAND            = "Brand",
  FIELD_SALE_FINAL_PRICE      = "Final Selling Price",
  FIELD_SALE_VAT_TYPE         = "VAT Type",
  FIELD_SALE_SELLER_LINK      = "Seller ID",
  FIELD_SALE_ORDER_LINK       = "Order Number",

  // --- OFFER MSG FIELDS
  FIELD_OFFERS_ORDER_ID       = "Order Record ID",
  FIELD_OFFERS_CHANNEL_ID     = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID     = "Message ID",
  FIELD_OFFERS_SELLER_ID,
  FIELD_OFFERS_INV_ID,
  FIELD_OFFERS_OFFER_PRICE,

  // --- EXTERNAL FIELD
  FIELD_OFFER_STATUS          = "Offer Status",
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

const toNumber = (val) => {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseFloat(val.replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isNaN(n) ? null : n;
  }
  return null;
};

const getFirstLinkedId = (val) => {
  if (!Array.isArray(val) || !val.length) return null;
  const first = val[0];
  if (typeof first === "string") return first;
  if (first && typeof first.id === "string") return first.id;
  return null;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

/* Offer messages log/read */
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

/* Idempotency check: do we already have a Sale with this orderRecId linked? */
export async function hasSaleForOrder(orderRecId) {
  const fieldName = process.env.FIELD_SALE_ORDER_LINK || "Order Number";
  const formula = `FIND('${orderRecId}', ARRAYJOIN({${fieldName}}))`;
  const url = `${encodeURIComponent(AIRTABLE_TABLE_SALES)}?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;
  const data = await airtableRequest("GET", url);
  return Array.isArray(data.records) && data.records.length > 0;
}

/* Set Offer Status = Confirmed (External Sales Log) */
export async function setOfferStatus({ orderRecId, statusName = "Confirmed" }) {
  const tableName = AIRTABLE_TABLE_EXTERNAL;
  const recUrl = `${encodeURIComponent(tableName)}/${orderRecId}`;
  const field = process.env.FIELD_OFFER_STATUS || "Offer Status";

  try {
    await airtableRequest("PATCH", recUrl, {
      fields: { [field]: { name: statusName } },
    });
  } catch {
    await airtableRequest("PATCH", recUrl, {
      fields: { [field]: statusName },
    });
  }
}

/* Sales creation + decrement */
export async function createSaleAndDecrement({ inventoryId, orderRecId, finalPrice }) {
  const inv = await airtableRequest("GET", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`);
  const f = inv.fields || {};

  const productName  = toText(f[FIELD_INV_PRODUCT_NAME]) || "";
  theSize           = toText(f[FIELD_INV_SIZE]) || "";
  const brand        = toText(f[FIELD_INV_BRAND]) || "";
  const vatTypeName  = (toText(f[FIELD_INV_VAT_TYPE]) || "").toUpperCase();

  const skuLinkId     = getFirstLinkedId(f[FIELD_INV_LINK_SKU_MASTER]);
  const sellerLinkId  = getFirstLinkedId(f[FIELD_INV_LINKED_SELLER]);
  if (!sellerLinkId) throw new Error(`Inventory ${inventoryId}: Linked Seller empty.`);
  if (!skuLinkId)    throw new Error(`Inventory ${inventoryId}: SKU Master empty.`);

  const vatTypeOut = vatTypeName === "VAT0" ? "VAT21" : (vatTypeName || "Margin");

  const saleFields = {
    [FIELD_SALE_PRODUCT_NAME]: productName,
    [FIELD_SALE_SIZE]:         theSize,
    [FIELD_SALE_BRAND]:        brand,
    [FIELD_SALE_FINAL_PRICE]:  round2(finalPrice),
    [FIELD_SALE_VAT_TYPE]:     vatTypeOut,
    [FIELD_SALE_SKU_LINK]:     [skuLinkId],
    [FIELD_SALE_SELLER_LINK]:  [sellerLinkId],
    [FIELD_SALE_ORDER_LINK]:   orderRecId ? [orderRecId] : undefined,
  };

  await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_SALES), { fields: saleFields });

  const currentQty = toNumber(f[FIELD_INV_QTY]) ?? 0;
  const newQty = Math.max(0, currentQty - 1);

  await airtableRequest(
    "PATCH",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`,
    { fields: { [FIELD_INV_QTY]: newQty } }
  );
}
