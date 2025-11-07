// lib/discord.js
import fetch from "node-fetch";
import { Client, GatewayIntentBits, Events } from "discord.js";

const {
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  DISCORD_CHANNEL_ID,
  ALLOW_CHANNEL_CREATE
} = process.env;

const EXTERNAL_CHANNEL_NAME = process.env.EXTERNAL_CHANNEL_NAME || "pre-confirms"; // Offer & Confirm go here
const CONFIRM_CHANNEL_NAME  = process.env.CONFIRM_CHANNEL_NAME  || "pre-confirms"; // same as above
const DEAL_CHANNEL_NAME = process.env.DEAL_CHANNEL_NAME || "deal-updates";

const API = "https://discord.com/api/v10";

let client;
export async function initDiscord() {
  if (client) return client;
  client = new Client({ intents: [GatewayIntentBits.Guilds] });
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
      const [action, orderRecId, sellerId, inventoryRecordId, offerPriceStr, vatLabel] =
        String(interaction.customId).split("|");
      const offerPrice = Number(offerPriceStr);
      await handler({
        action, orderRecId, sellerId, inventoryRecordId, offerPrice, vatLabel,
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
  const target =
    kind === "external" ? EXTERNAL_CHANNEL_NAME :
    kind === "confirm"  ? CONFIRM_CHANNEL_NAME  :
    kind === "deal"     ? DEAL_CHANNEL_NAME     :
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

/* -------------------- Senders -------------------- */
export async function sendExternalOfferMessageGateway({
  orderRecId, orderHumanId, sellerId, sellerName, inventoryRecordId,
  productName, sku, size,
  yourLabel, yourValue, ourLabel, ourValue,
  offerPrice, // number used for Accept button & storage
  vatLabel,   // "Margin" | "VAT0" | "VAT21"
}) {
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, "external");
  if (!channelId) throw new Error(`[Discord] No channel for seller="${sellerName || sellerId}" kind=external`);

  const components = [{
    type: 1,
    components: [
      { type: 2, style: 3, label: `Accept Offer ${ourValue.split(" ")[0]}`, custom_id: `confirm_ext|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice ?? 0}|${(vatLabel || "").trim()}` },
      { type: 2, style: 4, label: "Deny",                                   custom_id: `deny_ext|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice ?? 0}|${(vatLabel || "").trim()}` }
    ]
  }];

  const embed = {
    title: "💸 We Have A Potential Buyer Offer",
    description: [
      "If you can do this price, click **Accept Offer**.",
      "FCFS — we may contact multiple sellers.",
      "After accepting, we’ll notify you as soon as the deal is closed.",
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
      { name: yourLabel || "Your Price", value: yourValue || "—", inline: true },
      { name: ourLabel  || "Our Offer",  value: ourValue  || "—", inline: true },
    ],
    footer: { text: `SellerID: ${sellerId}` },
    timestamp: new Date().toISOString()
  };

  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: `📑 Offer sent for ${sku} / ${size}`, embeds: [embed], components })
  });
  if (!res.ok) throw new Error(`send external offer → ${res.status} ${await res.text()}`);
  const msg = await res.json();
  return { channelId, messageId: msg.id };
}

export async function sendExternalConfirmationMessageGateway({
  orderRecId, orderHumanId, sellerId, sellerName, inventoryRecordId,
  productName, sku, size,
  sellingLine,   // e.g., "Selling Price €120.00 (VAT 21%)"
  confirmPrice,  // number to store on Confirm
  vatLabel,      // "Margin" | "VAT0" | "VAT21"
}) {
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, "external"); // same channel as offers
  if (!channelId) throw new Error(`[Discord] No channel for seller="${sellerName || sellerId}" kind=external`);

  const components = [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "Confirm", custom_id: `confirm_ext|${orderRecId}|${sellerId}|${inventoryRecordId}|${confirmPrice ?? 0}|${(vatLabel || "").trim()}` },
      { type: 2, style: 4, label: "Deny",    custom_id: `deny_ext|${orderRecId}|${sellerId}|${inventoryRecordId}|${confirmPrice ?? 0}|${(vatLabel || "").trim()}` }
    ]
  }];

  const embed = {
    title: "🚀 We May Have A Buyer For Your Pair",
    description: [
      "If you still have this pair, click **Confirm**.",
      "FCFS — we may contact multiple sellers.",
      "After confirming, we’ll notify you as soon as the deal is closed.",
      "",
      "**Product Name**",
      productName || "—",
      "",
      `**SKU**\n${sku ?? "—"}`,
      `**Size**\n${size ?? "—"}`,
      "",
      "**Order**",
      orderHumanId || orderRecId || "—",
      "",
      sellingLine || "",   // keeps your “Selling Price €… (VAT …)” line
    ].join("\n"),
    color: 0x2ecc71,
    footer: { text: `SellerID: ${sellerId}` },
    timestamp: new Date().toISOString()
  };

  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: `📋 Match found for ${sku} / ${size}`, embeds: [embed], components })
  });
  if (!res.ok) throw new Error(`send external confirmation → ${res.status} ${await res.text()}`);
  const msg = await res.json();
  return { channelId, messageId: msg.id };
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
          { type: 2, style: 2, label: "Denied",    custom_id: "denied",    disabled: true }
        ]
      }],
      content: note ? `${note}` : undefined
    })
  });
  if (!r.ok) throw new Error(`edit message → ${r.status} ${await r.text()}`);
  return r.json();
}

export async function sendDealUpdateMessage({
  sellerId,            // e.g. "SE-00481"
  sellerName,          // category name; use this or sellerId
  content,             // plain text (required)
  embed                // optional: { title, description, color, fields:[{name,value,inline}] }
}) {
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, "deal");
  if (!channelId) throw new Error(`[Discord] No #deal-updates channel for "${sellerName || sellerId}"`);

  const body = {
    content: content?.slice(0, 1900) || "", // keep well under the 2k limit
    embeds: embed ? [{
      title: embed.title?.slice(0, 256),
      description: embed.description?.slice(0, 4000),
      color: typeof embed.color === "number" ? embed.color : 0x95a5a6,
      fields: Array.isArray(embed.fields) ? embed.fields.slice(0, 25).map(f => ({
        name: String(f.name || "").slice(0, 256),
        value: String(f.value || "").slice(0, 1024),
        inline: !!f.inline
      })) : undefined,
      footer: { text: `SellerID: ${sellerId || sellerName || "-"}` },
      timestamp: new Date().toISOString()
    }] : undefined
  };

  const r = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`deal update send → ${r.status} ${await r.text()}`);
  return r.json();
}

