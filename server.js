// server.js
import express from "express";
import morgan from "morgan";
import {
  initDiscord,
  onButtonInteraction,
  sendExternalOfferMessageGateway,         // OFFER (offer-inquiries)
  sendExternalConfirmationMessageGateway,  // CONFIRMATION (offer-inquiries)
  disableMessageButtonsGateway,
} from "./lib/discord.js";
import {
  logOfferMessage,
  listOfferMessagesForOrder,
  getInventoryLinkedSellerId,
  setExternalConfirmation,                 // writes Status, Price, Seller, Offer VAT Type
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

/* -------------------- Mode + display decision -------------------- */
function decideModeAndDisplay({
  vatTypeRaw, sellerCountry, sellerVatPct, sellerSuggestedRaw, ourOfferIncl,
}) {
  // Normalize VAT type (handles "VAT 0" / "VAT-0")
  const vt = String(vatTypeRaw || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/-/g, "");

  // Normalize seller VAT% (handles "21%" or 21)
  const sellerPct01 = toPct01(sellerVatPct ?? 21) ?? 0.21; // fallback 21%

  // Treat as NL if country is NL or (VAT0 + VAT%≈21) to be resilient
  const treatAsNL = isNL(sellerCountry) || (vt.includes("VAT0") && Math.abs(sellerPct01 * 100 - 21) < 0.5);

  let basisSeller, basisOurs, display;
  let confirmedVatType;

  if (vt.includes("MARGIN")) {
    // Compare incl; display incl (Margin)
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
    // Compare incl; display incl (VAT 21%)
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
    // VAT0 + NL → compare incl (uplift), display incl (VAT 21%)
    const factor = 1 + sellerPct01; // ~1.21
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
    // VAT0 + non-NL → compare/display on VAT0 basis (divide our incl by 1+VAT%)
    const divisor = 1 + sellerPct01; // ~1.21
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
    // Unknown → safe default: treat like VAT21 (incl basis)
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

  // Decide message type
  const mode = basisOurs < basisSeller ? "offer" : "confirm";
  return { mode, display, confirmedVatType, decision: { basisOurs, basisSeller } };
}

/* -------------------- External offers entry -------------------- */
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
      const ourOfferIncl      = Number(s.baseOfferIncl); // YOUR typed offer (incl VAT)
      if (![sellerSuggested, ourOfferIncl].every(n => Number.isFinite(n))) continue;

      const { mode, display, confirmedVatType } = decideModeAndDisplay({
        vatTypeRaw, sellerCountry, sellerVatPct, sellerSuggestedRaw: sellerSuggested, ourOfferIncl
      });

      if (mode === "offer") {
        // Offer: show both prices (per VAT rules)
        const offerPriceForButton = display.ourAmount; // what seller accepts if they click
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
          vatLabel: confirmedVatType, // carry VAT label to click handler
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
        // Confirm: show single "Selling Price ..." line
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
          vatLabel: confirmedVatType, // carry VAT label to click handler
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

/* -------------------- Close all offers for an external record -------------------- */
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

/* -------------------- Button interactions (external only) -------------------- */
await initDiscord();
await onButtonInteraction(async ({ action, orderRecId, sellerId, inventoryRecordId, offerPrice, vatLabel, channelId, messageId }) => {
  try {
    // External buttons are confirm_ext / deny_ext
    if (action === "deny_ext") {
      await disableMessageButtonsGateway(channelId, messageId, `❌ ${sellerId} denied / not available.`);
      return;
    }
    if (action !== "confirm_ext") return; // ignore anything else

    // Get linked seller from Inventory
    const confirmedSellerRecId = await getInventoryLinkedSellerId(inventoryRecordId);

    // Write Status + Price + Seller + Offer VAT Type
    await setExternalConfirmation({
      orderRecId,
      confirmedPrice: offerPrice,
      confirmedSellerRecId,
      statusName: "Confirmed",
      offerVatTypeLabel: vatLabel, // "Margin" | "VAT0" | "VAT21"
    });

    await disableMessageButtonsGateway(channelId, messageId, `✅ Confirmed by ${sellerId}.`);

    // Close other messages for this order
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP listening on :" + PORT));
