// server.js
import express from "express";
import morgan from "morgan";
import {
  initDiscord,
  onButtonInteraction,
  sendExternalOfferMessageGateway,
  disableMessageButtonsGateway,
} from "./lib/discord.js";
import {
  logOfferMessage,
  listOfferMessagesForOrder,
  // NEW helpers consumed here:
  getInventoryLinkedSellerId,
  setExternalConfirmation,
} from "./lib/airtable.js";

const processingOrders = new Set();

const app = express();
app.use(morgan("combined"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => res.type("text/plain").send("External offers service OK"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** External Sales Log → fan-out offers to sellers */
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
      const offerPriceIncl = s.finalOfferIncl;
      if (!isNum(offerPriceIncl)) {
        console.warn(`[external-offers] seller ${s.sellerId} missing finalOfferIncl; skipping`);
        continue;
      }

      const { channelId, messageId } = await sendExternalOfferMessageGateway({
        orderRecId,
        orderHumanId,
        sellerId: s.sellerId,
        sellerName: s.sellerName,
        inventoryRecordId: s.inventoryRecordId,
        productName: s.productName || null,
        sku,
        size,
        offerPrice: offerPriceIncl,
      });

      try {
        await logOfferMessage({
          orderRecId,
          sellerId: s.sellerId,
          inventoryRecordId: s.inventoryRecordId,
          channelId,
          messageId,
          offerPrice: offerPriceIncl,
        });
      } catch (e) {
        console.warn("logOfferMessage warn (external):", e.message);
      }

      results.push({ sellerId: s.sellerId, messageId });
    }

    res.json({ ok: true, sentCount: results.length, sent: results });
  } catch (e) {
    console.error("external-offers error:", e);
    res.status(500).json({ error: e.message });
  }
});

/** Close/disable all offer messages for an external record */
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

/** Button interactions (EXTERNAL flow only) */
await initDiscord();
await onButtonInteraction(async ({ action, orderRecId, sellerId, inventoryRecordId, offerPrice, channelId, messageId }) => {
  try {
    if (action !== "confirm_ext") {
      // deny_ext or anything else → just disable that message
      await disableMessageButtonsGateway(channelId, messageId, `❌ ${sellerId} denied / not available.`);
      return;
    }

    // 1) Mutex to avoid double processing on rapid clicks
    if (processingOrders.has(orderRecId)) {
      await disableMessageButtonsGateway(channelId, messageId, "⏳ Already being processed by another click.");
      return;
    }
    processingOrders.add(orderRecId);

    // 2) Resolve the Linked Seller record id from the Inventory row
    const confirmedSellerRecId = await getInventoryLinkedSellerId(inventoryRecordId);

    // 3) Write confirmation fields on the External Sales Log row
    await setExternalConfirmation({
      orderRecId,
      confirmedPrice: offerPrice,
      confirmedSellerRecId,
      statusName: "Confirmed",
    });

    // 4) Disable clicked message
    await disableMessageButtonsGateway(channelId, messageId, `✅ Confirmed by ${sellerId}.`);

    // 5) Disable all other messages for this external record
    const msgs = await listOfferMessagesForOrder(orderRecId);
    await Promise.allSettled(
      msgs
        .filter(m => !(m.channelId === channelId && m.messageId === messageId))
        .map(m => disableMessageButtonsGateway(m.channelId, m.messageId, "✅ Confirmed by another seller. Offers closed."))
    );
  } catch (e) {
    console.error("Interaction handling error:", e);
  } finally {
    processingOrders.delete(orderRecId);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP listening on :" + PORT));
