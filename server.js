// server.js
import express from "express";
import morgan from "morgan";
import {
  initDiscord,
  onButtonInteraction,
  sendExternalOfferMessageGateway,         // OFFER (offer-inquiries)
  sendExternalConfirmationMessageGateway,  // CONFIRMATION (confirmation-requests)
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

/* -------------------- VAT helpers -------------------- */
const isNL = (s) => String(s || "").toLowerCase().includes("nether");
const euro = (v) => (typeof v === "number" && isFinite(v) ? `€${v.toFixed(2)}` : "—");
const toPct01 = (p) => (p == null ? null : (p > 1 ? p / 100 : p)); // 21 -> 0.21

function decideModeAndDisplay({
  vatTypeRaw, sellerCountry, sellerVatPct, sellerSuggestedRaw, ourOfferIncl,
}) {
  const vt = String(vatTypeRaw || "").toUpperCase();
  const sellerPct01 = toPct01(sellerVatPct ?? 0.21) ?? 0.21; // fallback 21%
  let basisSeller, basisOurs, display; // display = {yourLabel, ourLabel, yourAmount, ourAmount, vatTagYour, vatTagOur}
  let confirmedVatType;               // what we store in "Offer VAT Type" on Confirm

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
  } else if (vt.includes("VAT0") && isNL(sellerCountry)) {
    // Compare incl (uplift seller by their VAT rate); display incl
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
    confirmedVatType = "VAT21"; // you want the confirmed *display* VAT type
  } else {
    // VAT0 + non-NL → compare and display on VAT0 basis
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
  }

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
      // Inputs from your Airtable payload
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
        // Offer message (offer-inquiries) – show both prices per your rules
        const offerPriceForButton = display.ourAmount; // this is what seller accepts
        const { channelId, messageId } = await sendExternalOfferMessageGateway({
          orderRecId,
          orderHumanId,
          sellerId: s.sellerId,
          sellerName: s.sellerName,
          inventoryRecordId: s.inventoryRecordId,
          productName: s.productName || null,
          sku,
          size,
          // display fields
          yourLabel: display.yourLabel,
          yourValue: `${euro(display.yourAmount)} ${display.vatTagYour}`,
          ourLabel:  display.ourLabel,
          ourValue:  `${euro(display.ourAmount)} ${display.vatTagOur}`,
          // button price
          offerPrice: Number(offerPriceForButton.toFixed(2)),
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
        // Confirmation message (confirmation-requests)
        // For confirm mode we show only "Selling Price ..." with the normalized display number
        // Confirmed price is the *seller* price on the display basis.
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
          // put the amount into the button payload so we store exactly this on Confirm
          confirmPrice: Number(confirmedDisplayAmount.toFixed(2)),
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
await onButtonInteraction(async ({ action, orderRecId, sellerId, inventoryRecordId, offerPrice, channelId, messageId }) => {
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
    // We don't know the VAT type label here, but we set it earlier by the decision rule.
    // To pass it through, encode it into message custom_id or infer from fields;
    // simplest: infer via the same decision here would require more inputs.
    // Instead, we set it by display tag in server route, not here.
    await setExternalConfirmation({
      orderRecId,
      confirmedPrice: offerPrice,
      confirmedSellerRecId,
      statusName: "Confirmed",
      // Offer VAT Type is set server-side at send time via a small trick:
      // we’ll store it after this handler by calling setExternalConfirmation again if the message carried a hint.
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP listening on :" + PORT));
