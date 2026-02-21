// ============================================================
// TrinketBot — Marketplace Module
// Raw Discord API implementation — no discord.js dependency.
// Uses Discord Gateway (WebSocket) + REST API directly.
// Supports select menus and file uploads inside modals via
// the Components v2 / LabelBuilder API (type 24 components).
// ============================================================

const WebSocket = require('ws');
const https     = require('https');
const fs        = require('fs');

const TOKEN   = process.env.MARKETPLACE_TOKEN;
const API     = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

// ── Storage ───────────────────────────────────────────────────
function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

let cooldowns = loadJSON('cooldowns.json');
let threads   = loadJSON('threads.json');
const userState = new Map();

// ── Config ────────────────────────────────────────────────────
const FORUM_ID         = '1466105963621777572';
const PANEL_CHANNEL_ID = '1467358343981961247';
const ADMIN_ROLE_ID    = '1465161088814289089';
const BOT_ROLE_ID      = '1465163793934848194';
const COLOR            = 0xe0ad76;
const COOLDOWN_DAYS    = 14;
const TAG_IDS = [
  '1466283217496707072','1466283356701331642','1466283393732837602',
  '1466283407695806808','1466283426075115583','1466283469452873730',
  '1466283480735420488','1466283506467602472','1466283529175437364',
  '1466283544480448552','1466283590080794867','1466283603565482118',
  '1466283716371288136','1466283732221820938','1466283816078278731',
  '1466704594510811270','1474194075220443166',
];

// ── REST helper ───────────────────────────────────────────────
function rest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request(`${API}${path}`, {
      method,
      headers: {
        'Authorization': `Bot ${TOKEN}`,
        'Content-Type':  'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); }
        catch { resolve({}); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Modal component builders ──────────────────────────────────
// Type 24 = Label (wraps a component with label + description)
// Type 4  = TextInput
// Type 3  = StringSelect
// Type 13 = FileUpload (in modals)

let _labelId = 1;
function labelId() { return _labelId++; }

function textInput(customId, label, placeholder, paragraph = false, required = true, maxLength = 200) {
  return {
    type: 24,
    id: labelId(),
    label,
    component: {
      type: 4,
      custom_id: customId,
      style: paragraph ? 2 : 1,
      placeholder,
      required,
      max_length: maxLength,
    },
  };
}

function selectMenu(customId, label, description, options, minValues = 1, maxValues = 1, required = true) {
  return {
    type: 24,
    id: labelId(),
    label,
    description,
    component: {
      type: 3,
      custom_id: customId,
      options,
      min_values: minValues,
      max_values: maxValues,
      required,
    },
  };
}

function fileUpload(customId, label, description, minValues = 1, maxValues = 10, required = true) {
  return {
    type: 24,
    id: labelId(),
    label,
    description,
    component: {
      type: 13,
      custom_id: customId,
      min_values: minValues,
      max_values: maxValues,
      required,
    },
  };
}

// ── Option sets ───────────────────────────────────────────────
const PAYMENT_OPTS = [
  { label: 'PayPal G&S', value: 'PayPal G&S' },
  { label: 'Venmo G&S',  value: 'Venmo G&S'  },
  { label: 'Other',      value: 'Other', description: '(see notes)' },
];
const SHIPPING_OPTS = [
  { label: 'Shipping cost included',   value: 'included'   },
  { label: 'Shipping cost additional', value: 'additional' },
];
const PACKAGING_OPTS = [
  { label: 'Box sealed',        value: 'Box sealed'        },
  { label: 'Box resealed',      value: 'Box resealed'      },
  { label: 'No box',            value: 'No box'            },
  { label: 'Tags attached',     value: 'Tags attached'     },
  { label: 'Tags detached',     value: 'Tags detached'     },
  { label: 'No tags',           value: 'No tags'           },
  { label: 'Other (see notes)', value: 'Other (see notes)' },
];
const CONDITION_OPTS = [
  { label: 'Sealed',            value: 'Sealed'            },
  { label: 'Opened',            value: 'Opened'            },
  { label: 'New',               value: 'New'               },
  { label: 'Other (see notes)', value: 'Other (see notes)' },
];

// ── Modal payloads ────────────────────────────────────────────
function step1Modal() {
  return {
    title: 'Create Listing — Step 1',
    custom_id: 'mp_s1',
    components: [
      textInput('count', 'How many items? (1–10)', 'e.g. 3', false, true, 2),
      textInput('info', 'General info (optional)', 'Shipping notes, bundle deals, location…', true, false, 500),
    ],
  };
}

function step2Modal() {
  return {
    title: 'Create Listing — Step 2',
    custom_id: 'mp_s2',
    components: [
      selectMenu('payment', 'Accepted payment methods', 'Select all that apply', PAYMENT_OPTS, 1, 3),
      selectMenu('shipping', 'Shipping policy', 'Is shipping included or extra?', SHIPPING_OPTS, 1, 1),
    ],
  };
}

function itemModal(i, total) {
  return {
    title: `Item ${i + 1} of ${total}`,
    custom_id: `mp_item_${i}`,
    components: [
      textInput('name',  'Item name',              'e.g. Jellycat Bashful Bunny Medium', false, true,  200),
      textInput('price', 'Price (USD)',             'e.g. 35.00 — no $ symbol',           false, true,  20),
      textInput('notes', 'Notes (optional)',        'Condition details, flaws, extras',    true,  false, 500),
      selectMenu('packaging', 'Packaging condition', 'How is the item packaged?',          PACKAGING_OPTS, 1, 1),
      selectMenu('condition', 'Item condition',      'What condition is the item itself?', CONDITION_OPTS, 1, 1),
    ],
  };
}

async function tagModal(guildId) {
  const forum = guildCache[guildId]?.channels?.[FORUM_ID];
  const tags  = forum?.available_tags || [];
  const opts  = TAG_IDS
    .filter(id => tags.find(t => t.id === id))
    .map(id => ({ label: tags.find(t => t.id === id).name.slice(0, 100), value: id }));
  if (!opts.length) return null;
  return {
    title: 'Create Listing — Tags',
    custom_id: 'mp_tags',
    components: [
      selectMenu('tags', 'Listing tags', 'Select all tags that describe your items', opts, 1, Math.min(opts.length, 25)),
    ],
  };
}

function photoModal() {
  return {
    title: 'Create Listing — Photos',
    custom_id: 'mp_photos',
    components: [
      fileUpload('photos', 'Photos (1–10 files)', "Each must show a handwritten note: username, server name, today's date"),
      textInput('confirm', 'Confirm handwritten note', 'Type YES to confirm', false, true, 3),
    ],
  };
}

// ── Response helpers ──────────────────────────────────────────
function respond(interactionId, interactionToken, type, data) {
  return rest('POST', `/interactions/${interactionId}/${interactionToken}/callback`, { type, data });
}

function showModal(interactionId, token, modal) {
  return respond(interactionId, token, 9, modal);
}

function replyEphemeral(interactionId, token, content) {
  return respond(interactionId, token, 4, { content, flags: 64 });
}

// ── Field extraction from modal submit ───────────────────────
function getFields(components) {
  const fields = {};
  function walk(comps) {
    for (const c of comps) {
      if (c.type === 24 && c.component) {
        const inner = c.component;
        if (inner.custom_id) fields[inner.custom_id] = inner;
      }
      if (c.components) walk(c.components);
    }
  }
  walk(components);
  return fields;
}

function textVal(fields, id) { return fields[id]?.value?.trim() || ''; }
function selectVals(fields, id) { return fields[id]?.values || []; }
function uploadedFiles(fields, id) { return fields[id]?.files || []; }
function deferReply(interactionId, interactionToken) {
  return respond(interactionId, interactionToken, 5);
}

// ── Guild cache (for forum tags) ──────────────────────────────
const guildCache = {};

// ── Post listing ──────────────────────────────────────────────
async function postListing(interactionId, token, state) {
  await deferReply(interactionId, token);

  const { userId, username, avatarUrl } = state;

  // Archive old thread
  if (threads[userId]) {
    try { await rest('PATCH', `/channels/${threads[userId]}`, { archived: true, locked: true }); } catch {}
  }

  // Resolve tags
  const forum    = await rest('GET', `/channels/${FORUM_ID}`);
  const tagObjs  = forum.available_tags || [];
  const tagObjMap = {};
  for (const t of tagObjs) tagObjMap[t.id] = t;
  const appliedTagIds = (state.tags || []).map(id => tagObjMap[id]?.id).filter(Boolean).slice(0, 5);

  if (!appliedTagIds.length) {
    return replyEphemeral(interactionId, token, '❌ None of the selected tags were found. Please contact an admin.');
  }

  const shippingLabel = state.shipping === 'included' ? 'Shipping cost included' : 'Shipping cost additional';

  // Build embed fields
  const fields = [];
  for (const [i, item] of state.items.entries()) {
    let value = `**${item.name}** — $${item.price}\nPackaging: ${item.packaging}  |  Condition: ${item.condition}`;
    if (item.notes) value += `\n> ${item.notes}`;
    fields.push({ name: `Item ${i + 1}`, value, inline: false });
  }
  fields.push({ name: 'Payment',  value: state.payment.join(', '), inline: true });
  fields.push({ name: 'Shipping', value: shippingLabel,             inline: true });
  if (state.info) fields.push({ name: 'General Info', value: state.info, inline: false });
  if (state.photoUrls?.length) {
    fields.push({
      name: '📸 Photos',
      value: state.photoUrls.map((u, i) => `[Photo ${i + 1}](${u})`).join('\n'),
      inline: false,
    });
  }

  const embed = {
    title:  `${username}'s Shop`,
    color:  COLOR,
    author: { name: username, icon_url: avatarUrl },
    fields,
    image:  state.photoUrls?.[0] ? { url: state.photoUrls[0] } : undefined,
    footer: { text: `Seller ID: ${userId}` },
    timestamp: new Date().toISOString(),
  };

  try {
    const result = await rest('POST', `/channels/${FORUM_ID}/threads`, {
      name:         `${username}'s Shop`,
      message:      { content: `**<@${userId}>'s Shop Listing**`, embeds: [embed] },
      applied_tags: appliedTagIds,
    });

    const threadId = result.id;
    threads[userId]   = threadId;
    cooldowns[userId] = new Date().toISOString();
    saveJSON('threads.json',   threads);
    saveJSON('cooldowns.json', cooldowns);
    userState.delete(userId);

    await rest(
      'POST',
      `/webhooks/${appId}/${token}`,
      { content: `✅ Your listing has been created: <#${threadId}>`, flags: 64 }
    );
  } catch (e) {
    console.error('postListing error:', e);
    await deferReply(id, token);

    await rest('POST', `/channels/${PANEL_CHANNEL_ID}/messages`, {...});
    
    return rest(
      'POST',
      `/webhooks/${appId}/${token}`,
      { content: `✅ Panel posted in <#${PANEL_CHANNEL_ID}>!`, flags: 64 }
);
  }
}

// ── Interaction handler ───────────────────────────────────────
async function handleInteraction(d) {
  const { id, token, type, data, member, guild_id } = d;
  const userId   = member?.user?.id || d.user?.id;
  const username = member?.user?.username || d.user?.username;
  const avatarHash = member?.user?.avatar || d.user?.avatar;
  const avatarUrl  = avatarHash
    ? `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  try {
    // ── Slash commands ──────────────────────────────────────
    if (type === 2 && data.name === 'setup_market') {
      const roles  = member?.roles || [];
      const perms  = BigInt(member?.permissions || '0');
      const isAdmin = roles.includes(ADMIN_ROLE_ID) || roles.includes(BOT_ROLE_ID) || (perms & 8n) === 8n;
      if (!isAdmin) return replyEphemeral(id, token, "❌ You don't have permission to use this command.");

      const panelEmbed = {
        title: 'Marketplace Listings',
        description:
          'Ready to sell? Click **Create Listing** to build your shop post!\n\n' +
          '**Requirements:**\n' +
          '- Photos must include a handwritten note: username, server name, and today\'s date\n' +
          '- 1–10 photos required\n' +
          '- One listing per **14 days**\n\n' +
          'Creating a new listing will automatically close your previous one.',
        color: COLOR,
      };

      await rest('POST', `/channels/${PANEL_CHANNEL_ID}/messages`, {
        embeds: [panelEmbed],
        components: [{
          type: 1,
          components: [{
            type: 2,
            style: 2,
            label: 'Create Listing',
            custom_id: 'create_marketplace_listing',
          }],
        }],
      });
      return replyEphemeral(id, token, `✅ Panel posted in <#${PANEL_CHANNEL_ID}>!`);
    }

    // ── Button: Create Listing ──────────────────────────────
    if (type === 3 && data.custom_id === 'create_marketplace_listing') {
      if (cooldowns[userId]) {
        const diffDays = (Date.now() - new Date(cooldowns[userId]).getTime()) / 86400000;
        if (diffDays < COOLDOWN_DAYS) {
          const daysLeft = Math.ceil(COOLDOWN_DAYS - diffDays);
          const nextDate = new Date(new Date(cooldowns[userId]).getTime() + COOLDOWN_DAYS * 86400000)
            .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return replyEphemeral(id, token,
            `❌ You can only create a listing once every ${COOLDOWN_DAYS} days.\nNext listing available: **${nextDate}** (~${daysLeft} day${daysLeft !== 1 ? 's' : ''}).`
          );
        }
      }
      userState.set(userId, { userId, username, avatarUrl, items: [], tags: [] });
      return showModal(id, token, step1Modal());
    }

    // ── Modal submissions ───────────────────────────────────
    if (type === 5) {
      const customId = data.custom_id;
      const fields   = getFields(data.components);
      const state    = userState.get(userId);

      // Step 1
      if (customId === 'mp_s1') {
        const count = parseInt(textVal(fields, 'count'), 10);
        if (isNaN(count) || count < 1 || count > 10) {
          return replyEphemeral(id, token, '❌ Please enter a whole number between 1 and 10.');
        }
        userState.set(userId, {
          userId, username, avatarUrl,
          itemCount: count,
          info:      textVal(fields, 'info'),
          items: [], tags: [], payment: null, shipping: null,
        });
        return showModal(id, token, step2Modal());
      }

      // Step 2
      if (customId === 'mp_s2') {
        if (!state) return replyEphemeral(id, token, '❌ Session expired. Please start again.');
        state.payment  = selectVals(fields, 'payment');
        state.shipping = selectVals(fields, 'shipping')[0];
        return showModal(id, token, itemModal(0, state.itemCount));
      }

      // Per-item modals
      if (customId.startsWith('mp_item_')) {
        if (!state) return replyEphemeral(id, token, '❌ Session expired. Please start again.');
        const i     = parseInt(customId.split('_')[2], 10);
        const price = parseFloat(textVal(fields, 'price').replace(/[$,]/g, ''));
        if (isNaN(price) || price <= 0) {
          return replyEphemeral(id, token, '❌ Price must be a positive number (e.g. 25.00).');
        }
        state.items.push({
          name:      textVal(fields, 'name'),
          price:     price.toFixed(2),
          notes:     textVal(fields, 'notes'),
          packaging: selectVals(fields, 'packaging')[0],
          condition: selectVals(fields, 'condition')[0],
        });
        const next = i + 1;
        if (next < state.itemCount) return showModal(id, token, itemModal(next, state.itemCount));
        const tm = await tagModal(guild_id);
        return tm ? showModal(id, token, tm) : showModal(id, token, photoModal());
      }

      // Tags
      if (customId === 'mp_tags') {
        if (!state) return replyEphemeral(id, token, '❌ Session expired. Please start again.');
        state.tags = selectVals(fields, 'tags');
        return showModal(id, token, photoModal());
      }

      // Photos
      if (customId === 'mp_photos') {
        if (!state) return replyEphemeral(id, token, '❌ Session expired. Please start again.');
        if (textVal(fields, 'confirm').toUpperCase() !== 'YES') {
          return replyEphemeral(id, token, '❌ You must type **YES** to confirm every photo includes the required handwritten note.');
        }
        const files = uploadedFiles(fields, 'photos');
        if (!files.length) return replyEphemeral(id, token, '❌ Please upload at least one photo.');
        state.photoUrls = files.map(f => f.url);
        return postListing(id, token, state);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    try { await replyEphemeral(id, token, `❌ An error occurred: ${err.message}`); } catch {}
  }
}

// ── Register slash command ────────────────────────────────────
async function registerCommands(appId) {
  try {
    await rest('PUT', `/applications/${appId}/commands`, [{
      name: 'setup_market',
      description: 'Post the marketplace listing panel',
      default_member_permissions: '32', // ManageGuild
    }]);
    console.log('Slash commands registered.');
  } catch (e) {
    console.error('Command registration failed:', e.message);
  }
}

// ── Gateway ───────────────────────────────────────────────────
let heartbeatInterval = null;
let sessionId         = null;
let resumeUrl         = null;
let sequence          = null;
let appId             = null;
let ws                = null;

function connect(url = GATEWAY) {
  ws = new WebSocket(url);

  ws.on('message', async raw => {
    const msg = JSON.parse(raw);
    const { op, d, s, t } = msg;
    if (s) sequence = s;

    if (op === 10) { // Hello
      heartbeatInterval = setInterval(() => {
        ws.send(JSON.stringify({ op: 1, d: sequence }));
      }, d.heartbeat_interval);

      // Identify
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token:   TOKEN,
          intents: 1 << 0, // GUILDS
          properties: { os: 'linux', browser: 'bot', device: 'bot' },
        },
      }));
    }

    if (op === 11) {} // Heartbeat ACK — no action needed

    if (op === 7) { // Reconnect
      ws.close();
      connect(resumeUrl || GATEWAY);
    }

    if (op === 9) { // Invalid session
      setTimeout(() => connect(GATEWAY), 5000);
    }

    if (op === 0) { // Dispatch
      if (t === 'READY') {
        sessionId = d.session_id;
        resumeUrl = d.resume_gateway_url;
        appId     = d.application.id;
        console.log(`Marketplace bot ready — logged in as ${d.user.username}#${d.user.discriminator}`);
        await registerCommands(appId);
      }

      if (t === 'GUILD_CREATE') {
        // Cache forum channel for tag resolution
        if (d.channels) {
          guildCache[d.id] = guildCache[d.id] || { channels: {} };
          for (const ch of d.channels) {
            if (ch.id === FORUM_ID) guildCache[d.id].channels[FORUM_ID] = ch;
          }
        }
      }

      if (t === "INTERACTION_CREATE") {
        console.log("INTERACTION received:", JSON.stringify({ type: d.type, custom_id: d.data?.custom_id ?? d.data?.name }));
        await handleInteraction(d);
      }
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeatInterval);
    console.log(`WebSocket closed (${code}): ${reason}. Reconnecting in 5s…`);
    setTimeout(() => connect(resumeUrl || GATEWAY), 5000);
  });

  ws.on('error', err => {
    console.error('WebSocket error:', err.message);
  });
}

connect();
