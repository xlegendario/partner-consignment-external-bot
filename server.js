// server.js
import express from "express";
import morgan from "morgan";
import {
  initDiscord,
  onButtonInteraction,
  sendExternalOfferMessageGateway,         // OFFER (pre-confirms)
  sendExternalConfirmationMessageGateway,  // CONFIRMATION (pre-confirms)
  disableMessageButtonsGateway,
  sendDealUpdateMessage,
} from "./lib/discord.js";
import {
  logOfferMessage,
  listOfferMessagesForOrder,
  getInventoryLinkedSellerId,
  setExternalConfirmation,

  // NEW helpers for finalize flow
  readExternalRecord,
  writeExternalFeedback,
  createSalesFromExternal,
  createAffiliateFromExternal,
} from "./lib/airtable.js";

const app = express();
app.use(morgan("combined"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => res.type("text/plain").send("External offers service OK"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

/* -------------------- Helpers -------------------- */
const isNL = (s) => {
  if (!s) return false;
  const t = String(s).trim().toLowerCase();
  if (t === "nl" || t === "nld" || t === "nederland" || t === "netherlands" || t === "the netherlands") return true;
  if (t.includes("neder") || t.includes("nether") || t.includes("🇳🇱")) return true;
  return false;
};
const euro = (v) => (typeof v === "number" && isFinite(v) ? `€${v.toFixed(2)}` : "—");
const toNumber = (v) => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const toPct01 = (p) => {
  const n = toNumber(p);
  if (n == null) return null;
  return n > 1 ? n / 100 : n; // 21 -> 0.21
};

// Helper to pull a readable string from Airtable single-select/lookup/text
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


/* -------------------- Mode + display decision (unchanged) -------------------- */
function decideModeAndDisplay({
  vatTypeRaw, sellerCountry, sellerVatPct, sellerSuggestedRaw, ourOfferIncl,
}) {
  const vt = String(vatTypeRaw || "").toUpperCase().replace(/\s+/g, "").replace(/-/g, "");
  const sellerPct01 = toPct01(sellerVatPct ?? 21) ?? 0.21;
  const treatAsNL = isNL(sellerCountry); // remove the "~21%" heuristic

  let basisSeller, basisOurs, display;
  let confirmedVatType;

  if (vt.includes("MARGIN")) {
    basisSeller = sellerSuggestedRaw;
    basisOurs   = ourOfferIncl;
    display = {
      yourAmount: sellerSuggestedRaw,
      ourAmount:  ourOfferIncl,
      vatTagYour: "(Margin)",
      vatTagOur:  "(Margin)",
      yourLabel:  "Your Price",
      ourLabel:   "Our Offer",
    };
    confirmedVatType = "Margin";

  } else if (vt.includes("VAT21")) {
    basisSeller = sellerSuggestedRaw;
    basisOurs   = ourOfferIncl;
    display = {
      yourAmount: sellerSuggestedRaw,
      ourAmount:  ourOfferIncl,
      vatTagYour: "(VAT 21%)",
      vatTagOur:  "(VAT 21%)",
      yourLabel:  "Your Price",
      ourLabel:   "Our Offer",
    };
    confirmedVatType = "VAT21";

  } else if (vt.includes("VAT0") && treatAsNL) {
    const factor = 1 + sellerPct01;
    basisSeller = sellerSuggestedRaw * factor;
    basisOurs   = ourOfferIncl;
    display = {
      yourAmount: sellerSuggestedRaw * factor,
      ourAmount:  ourOfferIncl,
      vatTagYour: "(VAT 21%)",
      vatTagOur:  "(VAT 21%)",
      yourLabel:  "Your Price",
      ourLabel:   "Our Offer",
    };
    confirmedVatType = "VAT21";

  } else if (vt.includes("VAT0")) {
    const divisor = 1 + sellerPct01;
    basisSeller = sellerSuggestedRaw;
    basisOurs   = ourOfferIncl / divisor;
    display = {
      yourAmount: sellerSuggestedRaw,
      ourAmount:  basisOurs,
      vatTagYour: "(VAT 0%)",
      vatTagOur:  "(VAT 0%)",
      yourLabel:  "Your Price",
      ourLabel:   "Our Offer",
    };
    confirmedVatType = "VAT0";

  } else {
    basisSeller = sellerSuggestedRaw;
    basisOurs   = ourOfferIncl;
    display = {
      yourAmount: sellerSuggestedRaw,
      ourAmount:  ourOfferIncl,
      vatTagYour: "(VAT 21%)",
      vatTagOur:  "(VAT 21%)",
      yourLabel:  "Your Price",
      ourLabel:   "Our Offer",
    };
    confirmedVatType = "VAT21";
  }

  const mode = basisOurs < basisSeller ? "offer" : "confirm";
  return { mode, display, confirmedVatType, decision: { basisOurs, basisSeller } };
}

// ───────────────── Deal Updates (called from Make) ─────────────────
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN; // set this in your env

app.post("/deal-update", async (req, res) => {
  try {
    // Simple auth: Make must send x-bot-key header matching env
    if (!DISCORD_BOT_TOKEN || req.headers["x-bot-key"] !== DISCORD_BOT_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const p = req.body || {};
    const sellerId   = p.sellerId || null;
    const sellerName = p.sellerName || sellerId;
    const content    = p.content;
    const embed      = p.embed || null; // optional

    if (!sellerName || !content) {
      return res.status(400).json({ error: "sellerName (or sellerId) and content are required" });
    }

    const msg = await sendDealUpdateMessage({ sellerId, sellerName, content, embed });
    res.json({ ok: true, messageId: msg.id, channelId: msg.channel_id });
  } catch (e) {
    console.error("deal-update error:", e);
    res.status(500).json({ error: e.message });
  }
});


/* -------------------- External offers entry (unchanged) -------------------- */
app.post("/external-offers", async (req, res) => {
  try {
    const p = req.body || {};
    const orderRecId   = p?.order?.airtableRecordId;
    const orderHumanId = p?.order?.orderId;
    const sku          = p?.order?.sku;
    const size         = p?.order?.size;
    const sellers      = Array.isArray(p?.sellers) ? p.sellers : [];
    if (!orderRecId || sellers.length === 0) {
      return res.status(400).json({ error: "Missing order or sellers in payload" });
    }

    const results = [];
    for (const s of sellers) {
      const vatTypeRaw        = s.sellerVatType;
      const sellerCountry     = s.sellerCountry || "";
      const sellerVatPct      = s.sellerVatRatePct ?? 21;
      const sellerSuggested   = Number(s.sellerSuggestedRaw);
      const ourOfferIncl      = Number(s.baseOfferIncl);
      if (![sellerSuggested, ourOfferIncl].every(n => Number.isFinite(n))) continue;

      const { mode, display, confirmedVatType } = decideModeAndDisplay({
        vatTypeRaw, sellerCountry, sellerVatPct, sellerSuggestedRaw: sellerSuggested, ourOfferIncl
      });

      if (mode === "offer") {
        const offerPriceForButton = display.ourAmount;
        const { channelId, messageId } = await sendExternalOfferMessageGateway({
          orderRecId,
          orderHumanId,
          sellerId: s.sellerId,
          sellerName: s.sellerName,
          inventoryRecordId: s.inventoryRecordId,
          productName: s.productName || null,
          sku,
          size,
          yourLabel: display.yourLabel,
          yourValue: `${euro(display.yourAmount)} ${display.vatTagYour}`,
          ourLabel:  display.ourLabel,
          ourValue:  `${euro(display.ourAmount)} ${display.vatTagOur}`,
          offerPrice: Number(offerPriceForButton.toFixed(2)),
          vatLabel: confirmedVatType,
        });

        await logOfferMessage({
          orderRecId,
          sellerId: s.sellerId,
          inventoryRecordId: s.inventoryRecordId,
          channelId,
          messageId,
          offerPrice: Number(display.ourAmount.toFixed(2)),
        });

        results.push({ sellerId: s.sellerId, messageId, kind: "offer", confirmedVatType });

      } else {
        const confirmedDisplayAmount = display.yourAmount;
        const { channelId, messageId } = await sendExternalConfirmationMessageGateway({
          orderRecId,
          orderHumanId,
          sellerId: s.sellerId,
          sellerName: s.sellerName,
          inventoryRecordId: s.inventoryRecordId,
          productName: s.productName || null,
          sku,
          size,
          sellingLine: `Selling Price ${euro(confirmedDisplayAmount)} ${display.vatTagYour}`,
          confirmPrice: Number(confirmedDisplayAmount.toFixed(2)),
          vatLabel: confirmedVatType,
        });

        await logOfferMessage({
          orderRecId,
          sellerId: s.sellerId,
          inventoryRecordId: s.inventoryRecordId,
          channelId,
          messageId,
          offerPrice: Number(confirmedDisplayAmount.toFixed(2)),
        });

        results.push({ sellerId: s.sellerId, messageId, kind: "confirm", confirmedVatType });
      }
    }

    res.json({ ok: true, sentCount: results.length, sent: results });
  } catch (e) {
    console.error("external-offers error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* -------------------- Close all offers (unchanged) -------------------- */
app.post("/disable-offers", async (req, res) => {
  try {
    const { orderRecId, reason } = req.body || {};
    if (!orderRecId) return res.status(400).json({ error: "Missing orderRecId" });

    const msgs = await listOfferMessagesForOrder(orderRecId);
    await Promise.allSettled(
      msgs.map(m =>
        disableMessageButtonsGateway(
          m.channelId,
          m.messageId,
          `✅ ${reason || "Closed"}. Offers disabled.`
        )
      )
    );

    res.json({ ok: true, disabled: msgs.length });
  } catch (e) {
    console.error("disable-offers error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* -------------------- Button interactions (unchanged) -------------------- */
await initDiscord();
await onButtonInteraction(async ({ action, orderRecId, sellerId, inventoryRecordId, offerPrice, vatLabel, channelId, messageId }) => {
  try {
    if (action === "deny_ext") {
      await disableMessageButtonsGateway(channelId, messageId, `❌ ${sellerId} denied / not available.`);
      return;
    }
    if (action !== "confirm_ext") return;

    const confirmedSellerRecId = await getInventoryLinkedSellerId(inventoryRecordId);

    await setExternalConfirmation({
      orderRecId,
      confirmedPrice: offerPrice,
      confirmedSellerRecId,
      statusName: "Confirmed",
      offerVatTypeLabel: vatLabel,       // "Margin" | "VAT0" | "VAT21"
      dealStatusName: "Closing",
      confirmedInventoryRecId: inventoryRecordId, // ← NEW: remember which Inventory row to decrement
    });

    await disableMessageButtonsGateway(channelId, messageId, `✅ Confirmed by ${sellerId}.`);

    const msgs = await listOfferMessagesForOrder(orderRecId);
    await Promise.allSettled(
      msgs
        .filter(m => !(m.channelId === channelId && m.messageId === messageId))
        .map(m => disableMessageButtonsGateway(m.channelId, m.messageId, "✅ Confirmed by another seller. Offers closed."))
    );
  } catch (e) {
    console.error("Interaction handling error:", e);
  }
});

/* ========================================================================
   NEW: Finalize External Deal → create Sales + Affiliate Sales
   Triggered by Airtable Automation (when Deal Status=Deal Closed AND Final Deal Price present)
   ======================================================================== */
app.post("/finalize-external-deal", async (req, res) => {
  const recordId = req.body?.recordId;
  if (!recordId) return res.status(400).json({ error: "Missing recordId" });

  try {
    const f = await readExternalRecord(recordId);

    // ---------- Required presence (unchanged) ----------
    const missing = [];
    if (f["Final Deal Price"] == null)                          missing.push("Final Deal Price");
    if (!Array.isArray(f["Buyer"]) || f["Buyer"].length === 0)  missing.push("Buyer");
    if (!Array.isArray(f["Shipping Label"]) || f["Shipping Label"].length === 0)
      missing.push("Shipping Label");

    if (missing.length) {
      await writeExternalFeedback(recordId, {
        feedback: `❌ Missing required: ${missing.join(", ")}.`,
        dealStatusName: "Closing",
      });
      return res.status(422).json({ error: "Missing required fields", missing });
    }

    // ---------- Confirmed-offer guard (unchanged) ----------
    const hasSKU            = Array.isArray(f["SKU"]) && f["SKU"].length > 0;
    const hasSeller         = Array.isArray(f["Confirmed Seller"]) && f["Confirmed Seller"].length > 0;
    const hasConfirmedPrice = f["Confirmed Offer Price"] != null;

    if (!hasSKU || !hasSeller || !hasConfirmedPrice) {
      await writeExternalFeedback(recordId, {
        feedback: "❌ Missing confirmed offer details (SKU / Confirmed Seller / Confirmed Offer Price). Confirm an offer first.",
        dealStatusName: "Closing",
      });
      return res.status(422).json({ error: "Missing confirmed offer pieces" });
    }

    // ---------- NEW: Selling VAT handling ----------
    const offerVatType   = toText(f["Offer VAT Type"]);     // stored earlier at confirmation
    const sellingVatSel  = toText(f["Selling VAT Type"]);   // employee-chosen single-select (VAT21 | VAT0 | Margin | Private)
    const buyerCountry   = toText(f["Buyer Country"]);      // lookup
    const buyerVatId     = toText(f["Buyer VAT ID"]);       // lookup
    const isPrivateSel   = (sellingVatSel || "").toLowerCase() === "private";

    // Map "Private" to the real invoice VAT regime (Margin stays Margin; otherwise VAT21)
    function mapSellingVat(offerVat, sellingSel) {
      const sel = (sellingSel || "").toUpperCase();
      const off = (offerVat || "").toUpperCase();

      if (off.includes("MARGIN")) {
        // Margin goods must be invoiced as Margin
        return "Margin";
      }
      if (sel === "PRIVATE") {
        // Private buyers → VAT21 on invoice (unless Margin handled above)
        return "VAT21";
      }
      if (sel === "VAT21" || sel === "VAT 21%") return "VAT21";
      if (sel === "VAT0"  || sel === "VAT 0%")  return "VAT0";
      if (sel === "MARGIN")                     return "Margin";
      return null;
    }

    const mappedVat = mapSellingVat(offerVatType, sellingVatSel);
    if (!mappedVat) {
      await writeExternalFeedback(recordId, {
        feedback: "❌ Selling VAT Type is missing or invalid.",
        dealStatusName: "Closing",
      });
      return res.status(422).json({ error: "Invalid Selling VAT Type" });
    }

    // Structural validity
    if ((offerVatType || "").toUpperCase().includes("MARGIN")) {
      // Margin can ONLY be sold as Margin. If staff explicitly chose non-Margin (not Private), block.
      if (!isPrivateSel && (sellingVatSel || "").toUpperCase() !== "MARGIN") {
        await writeExternalFeedback(recordId, {
          feedback: "❌ Margin goods must be invoiced as Margin.",
          dealStatusName: "Closing",
        });
        return res.status(422).json({ error: "Margin must be sold as Margin" });
      }
    } else {
      // Non-Margin goods
      if (mappedVat === "VAT0") {
        // VAT0 only for non-NL company with valid VAT ID
        if (isNL(buyerCountry)) {
          await writeExternalFeedback(recordId, {
            feedback: "❌ VAT 0% selected but Buyer Country is NL. Use VAT 21% or adjust buyer.",
            dealStatusName: "Closing",
          });
          return res.status(422).json({ error: "VAT0 not allowed for NL buyer" });
        }
        if (!buyerVatId) {
          await writeExternalFeedback(recordId, {
            feedback: "❌ VAT 0% selected but Buyer VAT ID is missing. Provide VAT ID or use VAT 21%.",
            dealStatusName: "Closing",
          });
          return res.status(422).json({ error: "VAT0 requires Buyer VAT ID" });
        }
      }
    }

    // ---------- Minimum floor check based on mapped VAT ----------
    const toNumber = (v) => {
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const n = parseFloat(v.replace(/[^\d.,-]/g, "").replace(",", "."));
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    const finalDeal     = toNumber(f["Final Deal Price"]);
    const exceptionOk   = !!f["Exception Approved?"];

    const minByVat = {
      "VAT0":   f["Minimum Deal Price (VAT 0%)"],
      "VAT21":  f["Minimum Deal Price (VAT 21%)"],
      "Margin": f["Minimum Deal Price (Margin)"],
    };
    const minForMapped = toNumber(minByVat[mappedVat]);

    if (minForMapped != null && finalDeal != null && finalDeal < minForMapped && !exceptionOk) {
      await writeExternalFeedback(recordId, {
        feedback: `❌ Final Deal Price (${euro(finalDeal)}) is lower than the minimum for ${mappedVat} (${euro(minForMapped)}). Ask Admin for approval or adjust Selling VAT Type/price.`,
        dealStatusName: "Closing",
      });
      return res.status(422).json({ error: "Below minimum for selected Selling VAT Type" });
    }

    // ---------- Create Sales with VAT override ----------
    let salesId;
    try {
      salesId = await createSalesFromExternal(f, { overrideVatType: mappedVat });
    } catch (e) {
      await writeExternalFeedback(recordId, {
        feedback: `❌ Could not create Sales: ${e.message}`,
        dealStatusName: "Closing",
      });
      return res.status(500).json({ error: "Sales create failed", detail: e.message });
    }

    // ---------- Create Affiliate Sales (unchanged logic) ----------
    try {
      await createAffiliateFromExternal(f, salesId);
    } catch (e) {
      await writeExternalFeedback(recordId, {
        feedback: `⚠️ Sales created (${salesId}) but Affiliate Sales failed: ${e.message}`,
        dealStatusName: "Closing",
      });
      return res.status(500).json({ error: "Affiliate Sales create failed", salesId, detail: e.message });
    }

    // ---------- Success ----------
    await writeExternalFeedback(recordId, {
      feedback: `✅ Deal processed. Sales created: ${salesId}. Affiliate Sales created successfully.`,
      dealStatusName: "Deal Processed",
    });

    return res.json({ ok: true, salesId });

  } catch (e) {
    console.error("finalize-external-deal error:", e);
    try {
      await writeExternalFeedback(recordId, {
        feedback: `❌ Server error: ${e.message}`,
        dealStatusName: "Closing",
      });
    } catch (_) {}
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP listening on :" + PORT));
