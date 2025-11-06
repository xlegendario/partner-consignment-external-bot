// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // Tables
  AIRTABLE_TABLE_INVENTORY   = "Inventory",
  AIRTABLE_TABLE_OFFER_MSGS  = "Offer Messages",
  AIRTABLE_TABLE_EXTERNAL    = "External Sales Log",
  AIRTABLE_TABLE_SALES       = "Sales",            // NEW (can override via env)
  AIRTABLE_TABLE_AFFILIATE   = "Affiliate Sales",  // NEW (can override via env)

  // Inventory fields
  FIELD_INV_LINKED_SELLER    = "Linked Seller",

  // Offer log fields
  FIELD_OFFERS_ORDER_ID      = "Order Record ID",
  FIELD_OFFERS_CHANNEL_ID    = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID    = "Message ID",
  FIELD_OFFERS_SELLER_ID,
  FIELD_OFFERS_INV_ID,
  FIELD_OFFERS_OFFER_PRICE,

  // External Sales Log fields
  FIELD_OFFER_STATUS         = "Offer Status",
  FIELD_CONFIRMED_PRICE      = "Confirmed Offer Price",
  FIELD_CONFIRMED_SELLER     = "Confirmed Seller",
  FIELD_OFFER_VAT_TYPE       = "Offer VAT Type", // single select Margin / VAT0 / VAT21
  FIELD_DEAL_STATUS          = "Deal Status",
  FIELD_BOT_FEEDBACK         = "Bot Feedback",
  FIELD_FINAL_DEAL_PRICE     = "Final Deal Price",
  FIELD_MINIMUM_DEAL_PRICE   = "Minimum Deal Price",
  FIELD_SHIPPING_LABEL       = "Shipping Label",
  FIELD_BUYER                = "Buyer",
  FIELD_PRODUCT_NAME         = "Product Name",
  FIELD_SKU                  = "SKU",
  FIELD_SIZE                 = "Size",
  FIELD_BRAND                = "Brand",
  FIELD_EXCEPTION_APPROVED   = "Exception Approved?",

  // Sales fields (write)
  FIELD_SALE_PRODUCT_NAME    = "Product Name",
  FIELD_SALE_SKU             = "SKU",                 // link to same table as External.SKU
  FIELD_SALE_SIZE            = "Size",
  FIELD_SALE_BRAND           = "Brand",
  FIELD_SALE_VAT_TYPE        = "VAT Type",            // single select
  FIELD_SALE_FINAL_PRICE     = "Final Selling Price",
  FIELD_SALE_SELLER_LINK     = "Seller ID",           // link to same table as External.Confirmed Seller
  FIELD_SALE_SHIPPING_LABEL  = "Shipping Label",      // attachment

  // Affiliate Sales fields (write)
  FIELD_AFF_SKU              = "SKU",                 // link to same table as External.SKU
  FIELD_AFF_SELLING_PRICE    = "Selling Price",
  FIELD_AFF_LINKED_SALES     = "Linked Sales",        // link to Sales
} = process.env;

const AT_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

const toText = (val) => {
  if (val == null) return null;
  if (Array.isArray(val)) {
    // Airtable lookup returns array of primitives or {name, id,...}
    for (const v of val) {
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        if (typeof v.name === "string" && v.name.trim()) return v.name;
        if (typeof v.value === "string" && v.value.trim()) return v.value;
      }
    }
    return null;
  }
  if (typeof val === "object") {
    if (typeof val.name === "string") return val.name;
    if (typeof val.value === "string") return val.value;
    return null;
  }
  return String(val);
};

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

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const asNumber = (v) => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const getFirstLinkedId = (val) =>
  Array.isArray(val) && val.length
    ? (typeof val[0] === "string" ? val[0] : val[0]?.id)
    : null;
const getAllLinkedIds = (val) =>
  Array.isArray(val)
    ? val.map(x => (typeof x === "string" ? x : x?.id)).filter(Boolean)
    : [];
const attachmentsForWrite = (att) =>
  Array.isArray(att)
    ? att.filter(a => a?.url).map(a => ({ url: a.url, filename: a.filename || undefined }))
    : [];

/* -------------------- Offer messages log (unchanged) -------------------- */
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

/* -------------------- Helpers for confirmation write (unchanged) -------------------- */
export async function getInventoryLinkedSellerId(inventoryId) {
  const rec = await airtableRequest("GET", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`);
  const id = getFirstLinkedId(rec.fields?.[FIELD_INV_LINKED_SELLER]);
  if (!id) throw new Error(`Inventory ${inventoryId}: Linked Seller is empty.`);
  return id;
}

/* Write: Status, Confirmed Price, Confirmed Seller, Offer VAT Type, Deal Status ("Closing" on accept) */
export async function setExternalConfirmation({
  orderRecId,
  confirmedPrice,
  confirmedSellerRecId,
  statusName = "Confirmed",
  offerVatTypeLabel, // "Margin" | "VAT0" | "VAT21"
  dealStatusName = "Closing",
}) {
  const tableName = encodeURIComponent(AIRTABLE_TABLE_EXTERNAL);
  const recUrl = `${tableName}/${orderRecId}`;
  const fields = {};

  fields[FIELD_CONFIRMED_PRICE || "Confirmed Offer Price"] =
    typeof confirmedPrice === "number" ? round2(confirmedPrice) : null;

  fields[FIELD_CONFIRMED_SELLER || "Confirmed Seller"] =
    confirmedSellerRecId ? [confirmedSellerRecId] : [];

  try {
    fields[FIELD_OFFER_STATUS || "Offer Status"] = { name: statusName };
    if (offerVatTypeLabel) fields[FIELD_OFFER_VAT_TYPE || "Offer VAT Type"] = { name: offerVatTypeLabel };
    if (dealStatusName)     fields[FIELD_DEAL_STATUS || "Deal Status"]       = { name: dealStatusName };
    await airtableRequest("PATCH", recUrl, { fields });
  } catch {
    fields[FIELD_OFFER_STATUS || "Offer Status"] = statusName;
    if (offerVatTypeLabel) fields[FIELD_OFFER_VAT_TYPE || "Offer VAT Type"] = offerVatTypeLabel;
    if (dealStatusName)     fields[FIELD_DEAL_STATUS || "Deal Status"]       = dealStatusName;
    await airtableRequest("PATCH", recUrl, { fields });
  }
}

/* ==================== NEW: External → Sales & Affiliate helpers ==================== */

/** Read entire External Sales Log row (fields only) */
export async function readExternalRecord(recordId) {
  const path = `${encodeURIComponent(AIRTABLE_TABLE_EXTERNAL)}/${recordId}`;
  const { fields } = await airtableRequest("GET", path);
  return fields || {};
}

/** Write Bot Feedback + Deal Status (used on success/failure) */
export async function writeExternalFeedback(recordId, { feedback, dealStatusName }) {
  const path = `${encodeURIComponent(AIRTABLE_TABLE_EXTERNAL)}/${recordId}`;
  const fields = {};
  if (feedback != null) fields[FIELD_BOT_FEEDBACK || "Bot Feedback"] = String(feedback);
  if (dealStatusName)   fields[FIELD_DEAL_STATUS  || "Deal Status"]  = { name: dealStatusName };
  try {
    await airtableRequest("PATCH", path, { fields });
  } catch {
    if (dealStatusName) fields[FIELD_DEAL_STATUS || "Deal Status"] = dealStatusName;
    await airtableRequest("PATCH", path, { fields });
  }
}

/** Create Sales record from External fields; returns new Sales record id */
export async function createSalesFromExternal(ex) {
  const skuId        = getFirstLinkedId(ex[FIELD_SKU || "SKU"]);
  const sellerId     = getFirstLinkedId(ex[FIELD_CONFIRMED_SELLER || "Confirmed Seller"]);
  const shipping     = attachmentsForWrite(ex[FIELD_SHIPPING_LABEL || "Shipping Label"]);
  const vatName      = ex[FIELD_OFFER_VAT_TYPE || "Offer VAT Type"]?.name || null;
  const finalPrice   = asNumber(ex[FIELD_CONFIRMED_PRICE || "Confirmed Offer Price"]);

  const fields = {
    [FIELD_SALE_PRODUCT_NAME]: toText(ex[FIELD_PRODUCT_NAME || "Product Name"]) || null, // ← coerce lookup → text
    [FIELD_SALE_SKU]:          skuId ? [skuId] : [],
    [FIELD_SALE_SIZE]:         toText(ex[FIELD_SIZE || "Size"]) || null,
    [FIELD_SALE_BRAND]:        toText(ex[FIELD_BRAND || "Brand"]) || null,
    [FIELD_SALE_FINAL_PRICE]:  finalPrice != null ? round2(finalPrice) : null,
    [FIELD_SALE_SELLER_LINK]:  sellerId ? [sellerId] : [],
    [FIELD_SALE_SHIPPING_LABEL]: shipping.length ? shipping : undefined,
    ...(vatName ? { [FIELD_SALE_VAT_TYPE]: { name: vatName } } : {}),
  };

  const path = encodeURIComponent(AIRTABLE_TABLE_SALES);
  try {
    const r = await airtableRequest("POST", path, { fields });
    return r.id;
  } catch (e1) {
    if (vatName) fields[FIELD_SALE_VAT_TYPE] = vatName; // fallback form
    const r2 = await airtableRequest("POST", path, { fields });
    return r2.id;
  }
}


/** Create Affiliate Sales record; returns id */
export async function createAffiliateFromExternal(ex, salesId) {
  const skuId      = getFirstLinkedId(ex[FIELD_SKU || "SKU"]);
  const dealPrice  = asNumber(ex[FIELD_FINAL_DEAL_PRICE || "Final Deal Price"]);

  const fields = {
    [FIELD_AFF_SKU]:           skuId ? [skuId] : [],
    [FIELD_AFF_SELLING_PRICE]: dealPrice != null ? round2(dealPrice) : null,
    [FIELD_AFF_LINKED_SALES]:  salesId ? [salesId] : [],
  };

  const path = encodeURIComponent(AIRTABLE_TABLE_AFFILIATE);
  const r = await airtableRequest("POST", path, { fields });
  return r.id;
}
