// ============================================================
// TrinketBot — Marketplace Module
// Raw Discord API. No dependencies except 'ws'.
//
// TWO MODALS:
//   "Open Shop"  — creates the forum thread (run once)
//   "List Item"  — adds an item to existing thread (run repeatedly)
//
// Component types used:
//   18 = Label (wraps inner component with label + description)
//   3  = String Select (inside Label)
//   4  = Text Input    (inside Label)
//   19 = File Upload   (inside Label)
// ============================================================

const WebSocket = require('ws');
const https     = require('https');
const fs        = require('fs');

const TOKEN   = process.env.MARKETPLACE_TOKEN;
const API     = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

const httpsAgent = new https.Agent({ keepAlive: true });

// ── Storage ───────────────────────────────────────────────────
function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

let cooldowns = loadJSON('cooldowns.json');
let threads   = loadJSON('threads.json');

// ── Config ────────────────────────────────────────────────────
const FORUM_ID         = '1466105963621777572';
const PANEL_CHANNEL_ID = '1467358343981961247';
const ADMIN_ROLE_ID    = '1465161088814289089';
const BOT_ROLE_ID      = '1465163793934848194';
const COLOR            = 0xe0ad76;
const COOLDOWN_DAYS    = 14;

const TAG_IDS = [
  '1466283426075115583', '1466283469452873730', '1466283480735420488',
  '1466283506467602472', '1466283217496707072', '1466283356701331642',
  '1466283393732837602', '1466283407695806808', '1466283544480448552',
  '1466283529175437364', '1466283590080794867', '1466283603565482118',
  '1466283716371288136', '1466283732221820938', '1466283816078278731',
  '1466704594510811270', '1474194075220443166',
];

// ── REST ──────────────────────────────────────────────────────
function rest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request(`${API}${path}`, {
      agent: httpsAgent,
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
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          if (res.statusCode >= 400) {
            console.error(`REST ${method} ${path} -> ${res.statusCode}:`, JSON.stringify(parsed));
          }
          resolve(parsed);
        } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function respond(id, token, type, data) {
  return rest('POST', `/interactions/${id}/${token}/callback`, { type, data });
}
function showModal(id, token, modal) { return respond(id, token, 9, modal); }
function replyEphemeral(id, token, content) { return respond(id, token, 4, { content, flags: 64 }); }

// ── Label builder ─────────────────────────────────────────────
// Each label needs a unique integer id within the modal.
// We use a simple counter reset per modal build.
let _lid = 1;
const nextId = () => _lid++;
function resetIds() { _lid = 1; }

function label(id, labelText, description, innerComponent) {
  return { type: 18, id, label: labelText.slice(0, 45), description: description?.slice(0, 100), component: innerComponent };
}
function textInput(id, placeholder, paragraph = false, required = true, maxLength = 200) {
  return { type: 4, id, style: paragraph ? 2 : 1, placeholder, required, max_length: maxLength };
}
function stringSelect(id, placeholder, options, minValues, maxValues, required = true) {
  return { type: 3, id, placeholder, options, min_values: minValues, max_values: maxValues, required };
}
function fileUpload(id, minValues, maxValues, required = true) {
  return { type: 19, id, min_values: minValues, max_values: maxValues, required };
}

// ── Checkbox / Radio builders ─────────────────────────────────
// type 22 = Checkbox Group (multi-select, returns values[])
// type 21 = Radio Group    (single-select, returns value)
function checkboxGroup(id, options, minValues, maxValues, required = true) {
  return { type: 22, id, options, min_values: minValues, max_values: maxValues, required };
}
function radioGroup(id, options, required = true) {
  return { type: 21, id, options, required };
}

// ── Option sets ───────────────────────────────────────────────
const TRANSACTION_OPTS = [
  { label: 'Sale',   value: 'Sale'   },
  { label: 'Trade',  value: 'Trade'  },
  { label: 'Barter', value: 'Barter' },
];
const PAYMENT_OPTS = [
  { label: 'PayPal G&S', value: 'PayPal G&S' },
  { label: 'Venmo G&S',  value: 'Venmo G&S'  },
  { label: 'Other',      value: 'Other', description: 'see notes' },
];
const SHIPPING_OPTS = [
  { label: 'Shipping cost included',   value: 'included'   },
  { label: 'Shipping cost additional', value: 'additional' },
];
const CONDITION_OPTS = [
  { label: 'Boxed — sealed',       value: 'Boxed — sealed'       },
  { label: 'Boxed — top open',     value: 'Boxed — top open'     },
  { label: 'Boxed — bottom open',  value: 'Boxed — bottom open'  },
  { label: 'Boxed — fully open',   value: 'Boxed — fully open'   },
  { label: 'Boxed — no box',       value: 'Boxed — no box'       },
  { label: 'Tagged — NWT',         value: 'Tagged — NWT'         },
  { label: 'Tagged — NWRT',        value: 'Tagged — NWRT'        },
  { label: 'Tagged — NWOT',        value: 'Tagged — NWOT'        },
  { label: 'Pre-loved',            value: 'Pre-loved'            },
  { label: 'Other',                value: 'Other'                },
];

// ── "Open Shop" modal ─────────────────────────────────────────
// 5 labels max. We use all 5:
//   1. Transaction types (select, 1-3)
//   2. Accepted payments (select, 1-3)
//   3. Shipping (select, 1)
//   4. Tags (select, 1-17)
//   5. General notes (text, optional)
async function buildOpenShopModal(guildId) {
  resetIds();

  // Fetch forum tags
  const forum = await rest('GET', `/channels/${FORUM_ID}`);
  const tagMap = {};
  for (const t of forum.available_tags || []) tagMap[t.id] = t.name;
  const tagOpts = TAG_IDS
    .filter(id => tagMap[id])
    .map(id => ({ label: tagMap[id].slice(0, 100), value: id }));

  const l1 = nextId(), inner1 = nextId();
  const l2 = nextId(), inner2 = nextId();
  const l3 = nextId(), inner3 = nextId();
  const l4 = nextId(), inner4 = nextId();
  const l5 = nextId(), inner5 = nextId();

  return {
    title: 'Open Shop',
    custom_id: 'mp_open_shop',
    components: [
      label(l1, 'Transaction Types', 'Select all that apply',
        checkboxGroup(inner1, TRANSACTION_OPTS, 1, 3)),
      label(l2, 'Accepted Payments', 'Select all that apply',
        checkboxGroup(inner2, PAYMENT_OPTS, 1, 3)),
      label(l3, 'Shipping', 'Select one',
        radioGroup(inner3, SHIPPING_OPTS)),
      label(l4, 'Tags', 'Select all that apply (1–17)',
        stringSelect(inner4, 'Choose tags…', tagOpts, 1, Math.min(tagOpts.length, 25))),
      label(l5, 'General Notes (optional)', 'Bundle deals, location, other info',
        textInput(inner5, 'e.g. Bundle deals available, ships from NY…', true, false, 500)),
    ],
  };
}

// ── "List Item" modal ─────────────────────────────────────────
// 4 labels:
//   1. Item name (text)
//   2. Price USD (text)
//   3. Condition (select)
//   4. Photos (file upload, 1-5)
//   5. Additional notes (text, optional)
function buildListItemModal() {
  resetIds();
  const l1 = nextId(), inner1 = nextId();
  const l2 = nextId(), inner2 = nextId();
  const l3 = nextId(), inner3 = nextId();
  const l4 = nextId(), inner4 = nextId();
  const l5 = nextId(), inner5 = nextId();

  return {
    title: 'List Item',
    custom_id: 'mp_list_item',
    components: [
      label(l1, 'Item Name', 'Full name of the item',
        textInput(inner1, 'e.g. Jellycat Bashful Bunny Medium', false, true, 200)),
      label(l2, 'Price (USD)', 'Numbers only — no $ symbol',
        textInput(inner2, 'e.g. 35.00', false, true, 10)),
      label(l3, 'Condition', 'Select the condition that best applies',
        stringSelect(inner3, 'Select condition…', CONDITION_OPTS, 1, 1)),
      label(l4, 'Item Photos (1–5)', 'Upload 1 to 5 photos of this item',
        fileUpload(inner4, 1, 5)),
      label(l5, 'Additional Notes (optional)', 'Flaws, details, extras',
        textInput(inner5, 'e.g. Minor scuff on ear, barely noticeable', true, false, 500)),
    ],
  };
}

// ── Extract fields from modal submit ─────────────────────────
function getFields(components) {
  const fields = {};
  function walk(comps) {
    for (const c of comps || []) {
      if (c.type === 18 && c.component?.custom_id) {
        fields[c.component.custom_id] = c.component;
      }
      if (c.components) walk(c.components);
    }
  }
  walk(components);
  return fields;
}

function textVal(fields, id)    { return fields[id]?.value?.trim?.() || ''; }
function selectVals(fields, id) { return fields[id]?.values || []; }
function fileVals(fields, id)   { return fields[id]?.files || []; }

// ── Post forum thread (Open Shop) ─────────────────────────────
async function postShop(iid, token, userId, username, avatarUrl, state) {
  // Archive old thread
  if (threads[userId]) {
    try { await rest('PATCH', `/channels/${threads[userId]}`, { archived: true, locked: true }); } catch {}
  }

  const forum   = await rest('GET', `/channels/${FORUM_ID}`);
  const tagObjs = (forum.available_tags || []).reduce((m, t) => { m[t.id] = t; return m; }, {});
  const appliedTagIds = (state.tags || []).map(id => tagObjs[id]?.id).filter(Boolean).slice(0, 5);

  if (!appliedTagIds.length) {
    return replyEphemeral(iid, token, '❌ None of the selected tags were found. Please contact an admin.');
  }

  const shippingLabel = state.shipping === 'included' ? 'Shipping cost included' : 'Shipping cost additional';

  const embed = {
    title:     `${username}'s Shop`,
    color:     COLOR,
    author:    { name: username, icon_url: avatarUrl },
    fields: [
      { name: 'Transaction Types', value: state.transactions.join(', '), inline: true },
      { name: 'Payment',           value: state.payment.join(', '),      inline: true },
      { name: 'Shipping',          value: shippingLabel,                  inline: true },
      ...(state.notes ? [{ name: 'General Notes', value: state.notes, inline: false }] : []),
    ],
    footer:    { text: `Seller ID: ${userId} • Use "List Item" button to add items` },
    timestamp: new Date().toISOString(),
  };

  try {
    const result = await rest('POST', `/channels/${FORUM_ID}/threads`, {
      name:         `${username}'s Shop`,
      message:      {
        content: `**<@${userId}>'s Shop**\n-# Click **List Item** below to add items to this post.`,
        embeds:  [embed],
        components: [{
          type: 1,
          components: [{
            type: 2, style: 2,
            label: 'List Item',
            custom_id: 'add_listing_item',
          }],
        }],
      },
      applied_tags: appliedTagIds,
    });

    threads[userId]   = result.id;
    cooldowns[userId] = new Date().toISOString();
    saveJSON('threads.json',   threads);
    saveJSON('cooldowns.json', cooldowns);

    await replyEphemeral(iid, token, `✅ Your shop has been created: <#${result.id}>\nClick **List Item** in the thread to add your first item.`);
  } catch (e) {
    console.error('postShop error:', e);
    await replyEphemeral(iid, token, `❌ Failed to create shop: ${e.message}`);
  }
}

// ── Post item to existing thread ──────────────────────────────
async function postItem(iid, token, userId, username, avatarUrl, state) {
  const threadId = threads[userId];
  if (!threadId) {
    return replyEphemeral(iid, token, '❌ No active shop found. Open a shop first using the panel button.');
  }

  const photoLinks = (state.photoUrls || []).map((u, i) => `[Photo ${i + 1}](${u})`).join('  ');

  const embed = {
    color: COLOR,
    author: { name: `${username} — New Item`, icon_url: avatarUrl },
    fields: [
      { name: 'Item',      value: `**${state.name}** — $${state.price}`, inline: false },
      { name: 'Condition', value: state.condition,                        inline: true  },
      ...(state.notes ? [{ name: 'Notes', value: state.notes, inline: false }] : []),
      ...(photoLinks   ? [{ name: 'Photos', value: photoLinks, inline: false }] : []),
    ],
    image:    state.photoUrls?.[0] ? { url: state.photoUrls[0] } : undefined,
    timestamp: new Date().toISOString(),
  };

  try {
    await rest('POST', `/channels/${threadId}/messages`, { embeds: [embed] });
    await replyEphemeral(iid, token, `✅ Item added to your shop!`);
  } catch (e) {
    console.error('postItem error:', e);
    await replyEphemeral(iid, token, `❌ Failed to add item: ${e.message}`);
  }
}

// ── Interaction handler ───────────────────────────────────────
async function handleInteraction(d) {
  const { id, token, type, data, member, guild_id } = d;
  const userId     = member?.user?.id || d.user?.id;
  const username   = member?.user?.username || d.user?.username;
  const avatarHash = member?.user?.avatar || d.user?.avatar;
  const avatarUrl  = avatarHash
    ? `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  try {

    // ── /setup_market slash command ────────────────────────────
    if (type === 2 && data.name === 'setup_market') {
      const roles  = member?.roles || [];
      const perms  = BigInt(member?.permissions || '0');
      const isAdmin = roles.includes(ADMIN_ROLE_ID) || roles.includes(BOT_ROLE_ID) || (perms & 8n) === 8n;
      if (!isAdmin) return replyEphemeral(id, token, "❌ You don't have permission.");

      const panelEmbed = {
        title: 'Haus of Trinkets Marketplace',
        description:
          'Ready to sell, trade, or barter?\n\n' +
          '**→ Click Open Shop** to create your listing thread.\n' +
          '**→ Click List Item** inside your thread to add items.\n\n' +
          '**Requirements:**\n' +
          '- Item photos must include a handwritten note with your username, server name, and today\'s date\n' +
          '- One shop per **14 days** — opening a new shop closes your previous one',
        color: COLOR,
      };

      await rest('POST', `/channels/${PANEL_CHANNEL_ID}/messages`, {
        embeds: [panelEmbed],
        components: [{
          type: 1,
          components: [{
            type: 2, style: 2,
            label: 'Open Shop',
            custom_id: 'create_marketplace_listing',
          }],
        }],
      });
      return replyEphemeral(id, token, `✅ Marketplace panel posted in <#${PANEL_CHANNEL_ID}>!`);
    }

    // ── "Open Shop" button ─────────────────────────────────────
    if (type === 3 && data.custom_id === 'create_marketplace_listing') {
      if (cooldowns[userId]) {
        const diffDays = (Date.now() - new Date(cooldowns[userId]).getTime()) / 86400000;
        if (diffDays < COOLDOWN_DAYS) {
          const daysLeft = Math.ceil(COOLDOWN_DAYS - diffDays);
          const nextDate = new Date(new Date(cooldowns[userId]).getTime() + COOLDOWN_DAYS * 86400000)
            .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return replyEphemeral(id, token,
            `❌ You can only open a shop once every ${COOLDOWN_DAYS} days.\nNext available: **${nextDate}** (~${daysLeft} day${daysLeft !== 1 ? 's' : ''}).`
          );
        }
      }
      const modal = await buildOpenShopModal(guild_id);
      return showModal(id, token, modal);
    }

    // ── "List Item" button (inside shop thread) ────────────────
    if (type === 3 && data.custom_id === 'add_listing_item') {
      if (!threads[userId]) {
        return replyEphemeral(id, token, '❌ No active shop found. Please open a shop first.');
      }
      return showModal(id, token, buildListItemModal());
    }

    // ── Modal: Open Shop submitted ─────────────────────────────
    if (type === 5 && data.custom_id === 'mp_open_shop') {
      const fields = getFields(data.components);

      let transactionVals = [], paymentVals = [], shippingVal = '', tagVals = [], notes = '';

      for (const comp of Object.values(fields)) {
        // Checkbox Group (type 22) returns values[]
        if (comp.type === 22 && comp.values) {
          if (comp.values.every(v => TRANSACTION_OPTS.some(o => o.value === v))) transactionVals = comp.values;
          else if (comp.values.every(v => PAYMENT_OPTS.some(o => o.value === v))) paymentVals = comp.values;
        }
        // Radio Group (type 21) returns value (single string)
        if (comp.type === 21 && comp.value) {
          if (SHIPPING_OPTS.some(o => o.value === comp.value)) shippingVal = comp.value;
        }
        // String Select (type 3) for tags
        if (comp.type === 3 && comp.values) {
          if (comp.values.every(v => TAG_IDS.includes(v))) tagVals = comp.values;
        }
        // Text Input (type 4) for notes
        if (comp.type === 4) notes = comp.value?.trim() || '';
      }

      if (!transactionVals.length) return replyEphemeral(id, token, '❌ Please select at least one transaction type.');
      if (!paymentVals.length)     return replyEphemeral(id, token, '❌ Please select at least one payment method.');
      if (!shippingVal)            return replyEphemeral(id, token, '❌ Please select a shipping option.');
      if (!tagVals.length)         return replyEphemeral(id, token, '❌ Please select at least one tag.');

      return postShop(id, token, userId, username, avatarUrl, {
        transactions: transactionVals,
        payment:      paymentVals,
        shipping:     shippingVal,
        tags:         tagVals,
        notes,
      });
    }

    // ── Modal: List Item submitted ─────────────────────────────
    if (type === 5 && data.custom_id === 'mp_list_item') {
      const fields = getFields(data.components);

      let name = '', price = '', condition = '', notes = '', photoUrls = [];

      for (const comp of Object.values(fields)) {
        if (comp.type === 4) {
          const val = comp.value?.trim() || '';
          if (!name && val && !val.includes('.') && isNaN(parseFloat(val))) name = val;
          else if (!name) name = val;
          // price: short text that looks like a number
          if (!price && /^\d/.test(val) && val.length <= 10) price = val;
          if (comp.style === 2) notes = val; // paragraph = notes
        }
        if (comp.type === 3 && comp.values) condition = comp.values[0];
        if (comp.type === 19 && comp.files)  photoUrls = comp.files.map(f => f.url);
      }

      // More reliable: match by custom_id position since we know the order
      const comps = Object.values(fields);
      const textComps = comps.filter(c => c.type === 4);
      const selectComps = comps.filter(c => c.type === 3);
      const fileComps  = comps.filter(c => c.type === 19);

      name      = textComps[0]?.value?.trim() || '';
      price     = textComps[1]?.value?.trim().replace(/[$,]/g, '') || '';
      notes     = textComps[2]?.value?.trim() || '';
      condition = selectComps[0]?.values?.[0] || '';
      photoUrls = (fileComps[0]?.files || []).map(f => f.url);

      const parsedPrice = parseFloat(price);
      if (!name)                          return replyEphemeral(id, token, '❌ Item name is required.');
      if (isNaN(parsedPrice) || parsedPrice <= 0) return replyEphemeral(id, token, '❌ Price must be a positive number (e.g. 35.00).');
      if (!condition)                     return replyEphemeral(id, token, '❌ Please select a condition.');
      if (!photoUrls.length)              return replyEphemeral(id, token, '❌ Please upload at least one photo.');

      return postItem(id, token, userId, username, avatarUrl, {
        name,
        price: parsedPrice.toFixed(2),
        condition,
        notes,
        photoUrls,
      });
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
      description: 'Post the marketplace panel',
      default_member_permissions: '32',
    }]);
    console.log('Slash commands registered.');
  } catch (e) {
    console.error('Command registration failed:', e.message);
  }
}

// ── Gateway ───────────────────────────────────────────────────
let heartbeatInterval = null;
let resumeUrl = null;
let sequence  = null;
let ws        = null;

function connect(url = GATEWAY) {
  ws = new WebSocket(url);

  ws.on('message', async raw => {
    const { op, d, s, t } = JSON.parse(raw);
    if (s) sequence = s;

    if (op === 10) {
      heartbeatInterval = setInterval(() => ws.send(JSON.stringify({ op: 1, d: sequence })), d.heartbeat_interval);
      ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents: 1, properties: { os: 'linux', browser: 'bot', device: 'bot' } } }));
    }
    if (op === 7) { ws.close(); connect(resumeUrl || GATEWAY); }
    if (op === 9) { setTimeout(() => connect(GATEWAY), 5000); }

    if (op === 0) {
      if (t === 'READY') {
        resumeUrl = d.resume_gateway_url;
        console.log(`Marketplace bot ready — logged in as ${d.user.username}#${d.user.discriminator}`);
        await registerCommands(d.application.id);
      }
      if (t === 'INTERACTION_CREATE') {
        const t0 = Date.now();
        console.log('INTERACTION received:', JSON.stringify({ type: d.type, custom_id: d.data?.custom_id ?? d.data?.name }));
        await handleInteraction(d);
        console.log(`INTERACTION handled in ${Date.now() - t0}ms`);
      }
    }
  });

  ws.on('close', (code) => {
    clearInterval(heartbeatInterval);
    console.log(`WebSocket closed (${code}). Reconnecting in 5s…`);
    setTimeout(() => connect(resumeUrl || GATEWAY), 5000);
  });

  ws.on('error', err => console.error('WebSocket error:', err.message));
}

connect();
