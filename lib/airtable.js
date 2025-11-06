// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // Tables
  AIRTABLE_TABLE_INVENTORY    = "Inventory",
  AIRTABLE_TABLE_OFFER_MSGS   = "Offer Messages",
  AIRTABLE_TABLE_EXTERNAL     = "External Sales Log",
  AIRTABLE_TABLE_SALES        = "Sales",
  AIRTABLE_TABLE_AFFILIATE    = "Affiliate Sales",

  // Inventory fields
  FIELD_INV_LINKED_SELLER     = "Linked Seller",
  FIELD_INV_QTY               = "Quantity", // NEW: used for decrement

  // Offer log fields
  FIELD_OFFERS_ORDER_ID       = "Order Record ID",
  FIELD_OFFERS_CHANNEL_ID     = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID     = "Message ID",
  FIELD_OFFERS_SELLER_ID,
  FIELD_OFFERS_INV_ID,
  FIELD_OFFERS_OFFER_PRICE,

  // External Sales Log fields
  FIELD_OFFER_STATUS          = "Offer Status",
  FIELD_CONFIRMED_PRICE       = "Confirmed Offer Price",
  FIELD_CONFIRMED_SELLER      = "Confirmed Seller",
  FIELD_OFFER_VAT_TYPE        = "Offer VAT Type", // single-select: Margin | VAT21 | VAT0
  FIELD_DEAL_STATUS           = "Deal Status",
  FIELD_BOT_FEEDBACK          = "Bot Feedback",
  FIELD_FINAL_DEAL_PRICE      = "Final Deal Price",
  FIELD_MINIMUM_DEAL_PRICE    = "Minimum Deal Price",
  FIELD_SHIPPING_LABEL        = "Shipping Label",
  FIELD_BUYER                 = "Buyer",
  FIELD_PRODUCT_NAME          = "Product Name",
  FIELD_SKU                   = "SKU",
  FIELD_SIZE                  = "Size",
  FIELD_BRAND                 = "Brand",
  FIELD_EXCEPTION_APPROVED    = "Exception Approved?",
  FIELD_CONFIRMED_INVENTORY   = "Confirmed Inventory Unit", // NEW: link (preferred) or text field
  FIELD_LINKED_AFFILIATE      = "Linked Affiliate",

  // Sales fields (write)
  FIELD_SALE_PRODUCT_NAME     = "Product Name",
  FIELD_SALE_SKU              = "SKU",                 // link
  FIELD_SALE_SIZE             = "Size",
  FIELD_SALE_BRAND            = "Brand",
  FIELD_SALE_VAT_TYPE         = "VAT Type",            // single-select
  FIELD_SALE_FINAL_PRICE      = "Final Selling Price",
  FIELD_SALE_SELLER_LINK      = "Seller ID",           // link
  FIELD_SALE_SHIPPING_LABEL   = "Shipping Label",      // attachment

  // Affiliate Sales fields (write)
  FIELD_AFF_SKU               = "SKU",                 // link
  FIELD_AFF_SELLING_PRICE     = "Selling Price",
  FIELD_AFF_LINKED_SALES      = "Linked Sales",        // link to Sales
  FIELD_AFF_LINKED_AFFILIATE  = "Linked Affiliate",
} = process.env;

const AT_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

/* -------------------- Helpers -------------------- */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const asNumber = (v) => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const toText = (val) => {
  if (val == null) return null;

  if (Array.isArray(val)) {
    for (const v of val) {
      if (typeof v === "string" && v.trim()) return v.trim();
      if (v && typeof v === "object") {
        if (typeof v.name === "string" && v.name.trim()) return v.name.trim();
        if (typeof v.value === "string" && v.value.trim()) return v.value.trim();
      }
    }
    return null;
  }

  if (typeof val === "object") {
    if (typeof val.name === "string" && val.name.trim()) return val.name.trim();
    if (typeof val.value === "string" && val.value.trim()) return val.value.trim();
    return null;
  }

  return String(val);
};

const getSingleSelectLabel = (val) => {
  if (val == null) return null;
  if (Array.isArray(val)) {
    for (const v of val) {
      if (v && typeof v === "object" && typeof v.name === "string" && v.name.trim()) return v.name.trim();
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  }
  if (typeof val === "object" && typeof val.name === "string") return val.name.trim() || null;
  if (typeof val === "string") return val.trim() || null;
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

/* -------------------- Core request -------------------- */

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

/* -------------------- Offer messages log -------------------- */

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

/* -------------------- Helpers for confirmation write -------------------- */

export async function getInventoryLinkedSellerId(inventoryId) {
  const rec = await airtableRequest("GET", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`);
  const id = getFirstLinkedId(rec.fields?.[FIELD_INV_LINKED_SELLER]);
  if (!id) throw new Error(`Inventory ${inventoryId}: Linked Seller is empty.`);
  return id;
}

/* Write: Status, Confirmed Price, Confirmed Seller, Offer VAT Type, Deal Status, Confirmed Inventory Unit (NEW) */
export async function setExternalConfirmation({
  orderRecId,
  confirmedPrice,
  confirmedSellerRecId,
  statusName = "Confirmed",
  offerVatTypeLabel, // "Margin" | "VAT0" | "VAT21"
  dealStatusName = "Closing",
  confirmedInventoryRecId, // NEW
}) {
  const tableName = encodeURIComponent(AIRTABLE_TABLE_EXTERNAL);
  const recUrl = `${tableName}/${orderRecId}`;
  const fields = {};

  fields[FIELD_CONFIRMED_PRICE || "Confirmed Offer Price"] =
    typeof confirmedPrice === "number" ? round2(confirmedPrice) : null;

  fields[FIELD_CONFIRMED_SELLER || "Confirmed Seller"] =
    confirmedSellerRecId ? [confirmedSellerRecId] : [];

  // NEW: store which Inventory row was confirmed (so we can decrement later)
  if (confirmedInventoryRecId) {
    // Prefer linked field shape
    fields[FIELD_CONFIRMED_INVENTORY || "Confirmed Inventory Unit"] = [confirmedInventoryRecId];
  }

  try {
    fields[FIELD_OFFER_STATUS || "Offer Status"] = { name: statusName };
    if (offerVatTypeLabel) fields[FIELD_OFFER_VAT_TYPE || "Offer VAT Type"] = { name: offerVatTypeLabel };
    if (dealStatusName)     fields[FIELD_DEAL_STATUS   || "Deal Status"]     = { name: dealStatusName };
    await airtableRequest("PATCH", recUrl, { fields });
  } catch {
    fields[FIELD_OFFER_STATUS || "Offer Status"] = statusName;
    if (offerVatTypeLabel) fields[FIELD_OFFER_VAT_TYPE || "Offer VAT Type"] = offerVatTypeLabel;
    if (dealStatusName)     fields[FIELD_DEAL_STATUS   || "Deal Status"]     = dealStatusName;
    // Fallback for Confirmed Inventory Unit if the field is text (not link)
    if (confirmedInventoryRecId) {
      fields[FIELD_CONFIRMED_INVENTORY || "Confirmed Inventory Unit"] = confirmedInventoryRecId;
    }
    await airtableRequest("PATCH", recUrl, { fields });
  }
}

/* ==================== External → Sales & Affiliate helpers ==================== */

export async function readExternalRecord(recordId) {
  const path = `${encodeURIComponent(AIRTABLE_TABLE_EXTERNAL)}/${recordId}`;
  const { fields } = await airtableRequest("GET", path);
  return fields || {};
}

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

/** NEW: decrement Inventory.Quantity by `amount` (default 1) */
export async function decrementInventoryQuantity(inventoryId, amount = 1) {
  if (!inventoryId) return;

  // Read current qty
  const invPath = `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`;
  const inv = await airtableRequest("GET", invPath);
  const cur = asNumber(inv?.fields?.[FIELD_INV_QTY || "Quantity"]) ?? 0;

  const next = Math.max(0, (cur || 0) - (amount || 0));
  await airtableRequest("PATCH", invPath, {
    fields: { [FIELD_INV_QTY || "Quantity"]: next }
  });
}

/** Create Sales record from External fields; returns new Sales record id
 *  ALSO: if External.Confirmed Inventory Unit is set, decrement Quantity by 1 (NEW)
 */
export async function createSalesFromExternal(ex) {
  const skuId        = getFirstLinkedId(ex[FIELD_SKU || "SKU"]);
  const sellerId     = getFirstLinkedId(ex[FIELD_CONFIRMED_SELLER || "Confirmed Seller"]);
  const shipping     = attachmentsForWrite(ex[FIELD_SHIPPING_LABEL || "Shipping Label"]);
  const finalPrice   = asNumber(ex[FIELD_CONFIRMED_PRICE || "Confirmed Offer Price"]);
  const vatName      = getSingleSelectLabel(ex[FIELD_OFFER_VAT_TYPE || "Offer VAT Type"]);

  // NEW: pull confirmed Inventory record id (supports link or text)
  let confirmedInventoryId =
    getFirstLinkedId(ex[FIELD_CONFIRMED_INVENTORY || "Confirmed Inventory Unit"]) ||
    toText(ex[FIELD_CONFIRMED_INVENTORY || "Confirmed Inventory Unit"]);

  const fields = {
    [FIELD_SALE_PRODUCT_NAME]: toText(ex[FIELD_PRODUCT_NAME || "Product Name"]) || null,
    [FIELD_SALE_SKU]:          skuId ? [skuId] : [],
    [FIELD_SALE_SIZE]:         toText(ex[FIELD_SIZE || "Size"])  || null,
    [FIELD_SALE_BRAND]:        toText(ex[FIELD_BRAND || "Brand"]) || null,
    [FIELD_SALE_FINAL_PRICE]:  finalPrice != null ? round2(finalPrice) : null,
    [FIELD_SALE_SELLER_LINK]:  sellerId ? [sellerId] : [],
    [FIELD_SALE_SHIPPING_LABEL]: shipping.length ? shipping : undefined,
    ...(vatName ? { [FIELD_SALE_VAT_TYPE]: { name: vatName } } : {}),
  };

  const path = encodeURIComponent(AIRTABLE_TABLE_SALES);
  try {
    const r = await airtableRequest("POST", path, { fields });

    // NEW: decrement Quantity on the confirmed Inventory record
    if (confirmedInventoryId) {
      await decrementInventoryQuantity(confirmedInventoryId, 1);
    }
    return r.id;
  } catch (e1) {
    if (vatName) fields[FIELD_SALE_VAT_TYPE] = vatName; // fallback form
    const r2 = await airtableRequest("POST", path, { fields });

    if (confirmedInventoryId) {
      await decrementInventoryQuantity(confirmedInventoryId, 1);
    }
    return r2.id;
  }
}

/** Create Affiliate Sales record; returns new id */
export async function createAffiliateFromExternal(ex, salesId) {
  const skuId       = getFirstLinkedId(ex[FIELD_SKU || "SKU"]);
  const dealPrice   = asNumber(ex[FIELD_FINAL_DEAL_PRICE || "Final Deal Price"]);
  // NEW: grab Linked Affiliate from the External record
  // (uses first link; if you want to keep all, use getAllLinkedIds instead)
  const linkedAffiliateId = getFirstLinkedId(ex[FIELD_LINKED_AFFILIATE || "Linked Affiliate"]);

  const fields = {
    [FIELD_AFF_SKU]:           skuId ? [skuId] : [],
    [FIELD_AFF_SELLING_PRICE]: dealPrice != null ? round2(dealPrice) : null,
    [FIELD_AFF_LINKED_SALES]:  salesId ? [salesId] : [],
    ...(linkedAffiliateId ? { [FIELD_AFF_LINKED_AFFILIATE]: [linkedAffiliateId] } : {}),
  };

  const path = encodeURIComponent(AIRTABLE_TABLE_AFFILIATE);
  const r = await airtableRequest("POST", path, { fields });
  return r.id;
}

