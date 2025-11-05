// lib/discord.js
import fetch from "node-fetch";
import { Client, GatewayIntentBits, Events } from "discord.js";

const {
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  DISCORD_CHANNEL_ID,
  ALLOW_CHANNEL_CREATE
} = process.env;

// 👇 New: external channel name (configurable, default "offer-inquiries")
const EXTERNAL_CHANNEL_NAME = process.env.EXTERNAL_CHANNEL_NAME || "offer-inquiries";

const API = "https://discord.com/api/v10";

let client;
export async function initDiscord() {
  if (client) return client;
  client = new Client({ intents: [GatewayIntentBits.Guilds] }); // minimal
  await client.login(DISCORD_BOT_TOKEN);
  console.log("✅ Discord logged in as", client.user?.tag);
  return client;
}

export async function onButtonInteraction(handler) {
  await initDiscord();
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    await interaction.deferUpdate().catch(() => {});
    try {
      const [action, orderRecId, sellerId, inventoryRecordId, offerPriceStr] =
        String(interaction.customId).split("|");
      const offerPrice = Number(offerPriceStr);
      await handler({
        action, orderRecId, sellerId, inventoryRecordId, offerPrice,
        channelId: interaction.channelId,
        messageId: interaction.message?.id,
      });
    } catch (e) { console.error("onButtonInteraction error:", e); }
  });
}

/* -------------------- Channels -------------------- */
async function listGuildChannels() {
  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) throw new Error("Set DISCORD_CHANNEL_ID or DISCORD_GUILD_ID");
    return [{ id: DISCORD_CHANNEL_ID, type: 0, name: "fallback" }];
  }
  const r = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
  });
  if (!r.ok) throw new Error(`list channels → ${r.status} ${await r.text()}`);
  return r.json();
}

async function createChannel({ name, type, parent_id }) {
  const r = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    method: "POST",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, type, parent_id })
  });
  if (!r.ok) throw new Error(`create channel → ${r.status} ${await r.text()}`);
  return r.json();
}

async function getChannelIdForSeller(sellerNameOrId, kind) {
  // 👇 Map kind → channel name
  const target =
    kind === "confirm"  ? "confirmation-requests" :
    kind === "external" ? EXTERNAL_CHANNEL_NAME :
                          "offer-requests";
  if (!DISCORD_GUILD_ID) return { channelId: DISCORD_CHANNEL_ID, created: false };

  const chans = await listGuildChannels();
  const wanted = String(sellerNameOrId || "").trim().toLowerCase();

  const cat = chans.find(c => c.type === 4 && String(c.name).trim().toLowerCase() === wanted);
  let categoryId = cat?.id;
  if (!categoryId) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      categoryId = (await createChannel({ name: sellerNameOrId, type: 4 })).id;
    } else throw new Error(`Missing category "${sellerNameOrId}"`);
  }

  const ch = chans.find(c => c.type === 0 && c.parent_id === categoryId && c.name === target);
  if (ch) return { channelId: ch.id, created: false };

  if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
    const created = await createChannel({ name: target, type: 0, parent_id: categoryId });
    return { channelId: created.id, created: true };
  }

  throw new Error(`Missing channel "${target}" under "${sellerNameOrId}"`);
}

/* -------------------- Sender -------------------- */
const euro = (v) => (typeof v === "number" && isFinite(v) ? `€${v.toFixed(2)}` : "—");

/**
 * External flow – always send an OFFER (no compare).
 * Buttons: confirm_ext / deny_ext
 */
export async function sendExternalOfferMessageGateway({
  orderRecId,
  orderHumanId,
  sellerId,
  sellerName,
  inventoryRecordId,
  productName,
  sku,
  size,
  offerPrice,   // finalized per-seller (incl. VAT)
}) {
  // 👇 Route external to the new "offer-inquiries" channel
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, "external");
  if (!channelId) throw new Error(`[Discord] No channel for seller="${sellerName || sellerId}" kind=external`);

  const contentHeader = `📑 Offer sent for ${sku} / ${size}`;

  const embed = {
    title: "💸 We Got An Offer For Your Item",
    description: [
      "If you still have this pair, click **Accept Offer** below. FCFS — other sellers might also have this listed.",
      "",
      "**Product Name**",
      productName || "—",
      "",
      `**SKU**\n${sku ?? "—"}`,
      `**Size**\n${size ?? "—"}`,
      "",
      "**Order**",
      orderHumanId || orderRecId || "—",
    ].join("\n"),
    color: 0xf1c40f,
    fields: [
      { name: "Our Offer", value: offerPrice != null && isFinite(offerPrice) ? euro(offerPrice) : "—", inline: true },
    ],
    footer: { text: `SellerID: ${sellerId}` },
    timestamp: new Date().toISOString()
  };

  const components = [{
    type: 1,
    components: [
      { type: 2, style: 3, label: `Accept Offer ${euro(offerPrice)}`, custom_id: `confirm_ext|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice ?? 0}` },
      { type: 2, style: 4, label: "Deny",                              custom_id: `deny_ext|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice ?? 0}` }
    ]
  }];

  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: contentHeader, embeds: [embed], components })
  });
  if (!res.ok) throw new Error(`send external message → ${res.status} ${await res.text()}`);
  const msg = await res.json();
  return { channelId, messageId: msg.id, offerPrice };
}

export async function disableMessageButtonsGateway(channelId, messageId, note) {
  const r = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      components: [{
        type: 1,
        components: [
          { type: 2, style: 2, label: "Confirmed", custom_id: "confirmed", disabled: true },
          { type: 2, style: 2, label: "Denied", custom_id: "denied", disabled: true }
        ]
      }],
      content: note ? `${note}` : undefined
    })
  });
  if (!r.ok) throw new Error(`edit message → ${r.status} ${await r.text()}`);
  return r.json();
}
