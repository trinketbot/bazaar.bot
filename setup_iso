// ============================================================
// TrinketBot — ISO Module
// Plug-in alongside marketplace.js  OR  merge into it.
//
// New slash command : /setup_iso
// Buttons           : add_iso_item | remove_iso_item | edit_iso_item
// Modal             : mp_iso_submit | mp_iso_remove | mp_iso_edit
//
// Storage files:
//   iso_listings.json  — { userId: { threadId: { messageId, items:[{id,…}] } } }
//   iso_bumps.json     — { userId_threadId: isoDate }   (last posted/bumped)
// ============================================================

const https = require('https');
const fs    = require('fs');

// ── Re-use or duplicate from marketplace.js ───────────────────
const TOKEN = process.env.MARKETPLACE_TOKEN;
const API   = 'https://discord.com/api/v10';

const httpsAgent = new https.Agent({ keepAlive: true });

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── ISO-specific storage ──────────────────────────────────────
// isoListings[userId][threadId] = { messageId: string, items: [{ id, name, budget, condition, notes, ts }] }
// isoBumps[`${userId}_${threadId}`] = ISO date string of last post/bump
let isoListings = loadJSON('iso_listings.json');
let isoBumps    = loadJSON('iso_bumps.json');

// ── Config ────────────────────────────────────────────────────
const ISO_FORUM_ID     = '1466146126330597591';
const ADMIN_ROLE_ID    = '1465161088814289089';
const BOT_ROLE_ID      = '1465163793934848194';
const COLOR            = 0xe0ad76;
const BUMP_DAYS        = 14;

// IP thread IDs → we'll resolve their names from the API
const IPTHREAD_IDS = [
  '1466683002028560498', '1466982282106769451', '1466706222693482597',
  '1466700846166310945', '1466699623082102872', '1466698761844687062',
  '1466696231425413319', '1466693473804746897', '1466692748508794921',
  '1466690531840102440', '1466688832471826569', '1466686206116102429',
];

const CONDITION_OPTS = [
  { label: 'Boxed — sealed',      value: 'Boxed — sealed'      },
  { label: 'Boxed — top open',    value: 'Boxed — top open'    },
  { label: 'Boxed — bottom open', value: 'Boxed — bottom open' },
  { label: 'Boxed — fully open',  value: 'Boxed — fully open'  },
  { label: 'Boxed — no box',      value: 'Boxed — no box'      },
  { label: 'Tagged — NWT',        value: 'Tagged — NWT'        },
  { label: 'Tagged — NWRT',       value: 'Tagged — NWRT'       },
  { label: 'Tagged — NWOT',       value: 'Tagged — NWOT'       },
  { label: 'Pre-loved',           value: 'Pre-loved'           },
  { label: 'Other',               value: 'Other'               },
];

// ── REST helper (self-contained copy) ─────────────────────────
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
          if (res.statusCode >= 400)
            console.error(`REST ${method} ${path} -> ${res.statusCode}:`, JSON.stringify(parsed));
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
function showModal(id, token, modal)         { return respond(id, token, 9, modal); }
function replyEphemeral(id, token, content)  { return respond(id, token, 4, { content, flags: 64 }); }
function updateEphemeral(id, token, content, components = []) {
  return respond(id, token, 7, { content, components, flags: 64 });
}

// ── Unique item ID ────────────────────────────────────────────
function newItemId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// ── Resolve IP thread names ───────────────────────────────────
let _ipNameCache = null;
async function getIpOptions() {
  if (_ipNameCache) return _ipNameCache;
  const results = await Promise.all(
    IPTHREAD_IDS.map(id => rest('GET', `/channels/${id}`).then(ch => ({
      label: (ch.name || id).slice(0, 100),
      value: id,
    })).catch(() => ({ label: id, value: id })))
  );
  _ipNameCache = results;
  return results;
}

// ── Build the ISO embed for a user's listing ──────────────────
// items: [{ id, name, budget, condition, notes, ts }]
function buildIsoEmbed(username, avatarUrl, items) {
  const fields = [];
  for (const item of items) {
    const lines = [
      `**${item.name}**`,
      `Budget: $${item.budget}   |   Condition: ${item.condition}`,
      ...(item.notes ? [`*${item.notes}*`] : []),
    ];
    fields.push({ name: `#${item.id}`, value: lines.join('\n'), inline: false });
  }
  return {
    color:     COLOR,
    author:    { name: `${username}'s ISOs`, icon_url: avatarUrl },
    fields,
    footer:    { text: `Use "Edit Items" or "Remove Items" to manage your ISOs` },
    timestamp: new Date().toISOString(),
  };
}

// ── Post or update user's ISO message in the correct thread ───
async function upsertIsoListing(iid, token, userId, username, avatarUrl, threadId, newItem) {
  if (!isoListings[userId]) isoListings[userId] = {};
  const existing = isoListings[userId][threadId];

  let items;
  if (existing) {
    items = [...existing.items, newItem];
  } else {
    items = [newItem];
  }

  const embed = buildIsoEmbed(username, avatarUrl, items);
  const messageBody = { embeds: [embed] };

  if (existing?.messageId) {
    // Edit existing message
    await rest('PATCH', `/channels/${threadId}/messages/${existing.messageId}`, messageBody);
    isoListings[userId][threadId].items = items;
  } else {
    // Create new message
    const msg = await rest('POST', `/channels/${threadId}/messages`, messageBody);
    if (!msg.id) {
      return replyEphemeral(iid, token, '❌ Failed to post ISO. Check thread permissions.');
    }
    isoListings[userId][threadId] = { messageId: msg.id, items };
  }

  // Record bump timestamp
  isoBumps[`${userId}_${threadId}`] = new Date().toISOString();
  saveJSON('iso_listings.json', isoListings);
  saveJSON('iso_bumps.json', isoBumps);

  await replyEphemeral(iid, token, '✅ Your ISO has been posted!');
  scheduleBumpReminder(userId, threadId);
}

// ── Remove item from listing ──────────────────────────────────
async function removeIsoItem(iid, token, userId, username, avatarUrl, threadId, itemId) {
  const listing = isoListings[userId]?.[threadId];
  if (!listing) return replyEphemeral(iid, token, '❌ No listing found.');

  const before = listing.items.length;
  listing.items = listing.items.filter(i => i.id !== itemId);

  if (listing.items.length === before)
    return replyEphemeral(iid, token, '❌ Item not found.');

  if (listing.items.length === 0) {
    // Delete the message entirely
    await rest('DELETE', `/channels/${threadId}/messages/${listing.messageId}`);
    delete isoListings[userId][threadId];
  } else {
    const embed = buildIsoEmbed(username, avatarUrl, listing.items);
    await rest('PATCH', `/channels/${threadId}/messages/${listing.messageId}`, { embeds: [embed] });
  }

  saveJSON('iso_listings.json', isoListings);
  await replyEphemeral(iid, token, '✅ Item removed.');
}

// ── Edit item in listing ──────────────────────────────────────
async function editIsoItem(iid, token, userId, username, avatarUrl, threadId, itemId, patch) {
  const listing = isoListings[userId]?.[threadId];
  if (!listing) return replyEphemeral(iid, token, '❌ No listing found.');

  const item = listing.items.find(i => i.id === itemId);
  if (!item) return replyEphemeral(iid, token, '❌ Item not found.');

  Object.assign(item, patch);
  const embed = buildIsoEmbed(username, avatarUrl, listing.items);
  await rest('PATCH', `/channels/${threadId}/messages/${listing.messageId}`, { embeds: [embed] });
  saveJSON('iso_listings.json', isoListings);
  await replyEphemeral(iid, token, '✅ Item updated.');
}

// ── Bump reminder scheduler ───────────────────────────────────
// Sends an ephemeral-style DM-channel message to the user after BUMP_DAYS.
// Since true ephemeral scheduling isn't possible without persistent job storage,
// we use a lightweight setTimeout and also re-schedule on bot startup via
// `schedulePendingBumps()`.
const bumpTimers = {};

function scheduleBumpReminder(userId, threadId) {
  const key      = `${userId}_${threadId}`;
  const lastPost = isoBumps[key];
  if (!lastPost) return;

  const elapsed  = Date.now() - new Date(lastPost).getTime();
  const delay    = Math.max(0, BUMP_DAYS * 86400000 - elapsed);

  clearTimeout(bumpTimers[key]);
  bumpTimers[key] = setTimeout(async () => {
    const listing = isoListings[userId]?.[threadId];
    if (!listing) return;

    // Create a DM channel with the user and send the bump prompt
    try {
      const dm = await rest('POST', '/users/@me/channels', { recipient_id: userId });
      if (!dm.id) return;

      await rest('POST', `/channels/${dm.id}/messages`, {
        content: `👋 It's been ${BUMP_DAYS} days since you posted your ISO in <#${threadId}>! Would you like to bump your listing?`,
        components: [{
          type: 1,
          components: [
            {
              type: 2, style: 1,
              label: 'Bump my listing',
              custom_id: `iso_bump_${userId}_${threadId}`,
            },
            {
              type: 2, style: 4,
              label: 'No thanks',
              custom_id: `iso_bump_dismiss_${userId}_${threadId}`,
            },
          ],
        }],
      });
    } catch (e) {
      console.error('Bump DM failed:', e.message);
    }
  }, delay);
}

async function schedulePendingBumps() {
  for (const [key, ts] of Object.entries(isoBumps)) {
    const [userId, threadId] = key.split('_');
    if (userId && threadId) scheduleBumpReminder(userId, threadId);
  }
}

// ── Bump action ───────────────────────────────────────────────
async function bumpListing(iid, token, userId, threadId) {
  const listing = isoListings[userId]?.[threadId];
  if (!listing || !listing.items.length) {
    return updateEphemeral(iid, token, '❌ No active listing to bump.');
  }

  // Get current embed data from the existing message
  const existing = await rest('GET', `/channels/${threadId}/messages/${listing.messageId}`);
  const embed    = existing.embeds?.[0];
  if (!embed) return updateEphemeral(iid, token, '❌ Could not find your listing.');

  // Delete old message and repost
  await rest('DELETE', `/channels/${threadId}/messages/${listing.messageId}`);
  const newMsg = await rest('POST', `/channels/${threadId}/messages`, { embeds: [embed] });

  if (!newMsg.id) return updateEphemeral(iid, token, '❌ Failed to bump listing.');

  listing.messageId                  = newMsg.id;
  isoBumps[`${userId}_${threadId}`]  = new Date().toISOString();
  saveJSON('iso_listings.json', isoListings);
  saveJSON('iso_bumps.json', isoBumps);

  // Reschedule next bump
  scheduleBumpReminder(userId, threadId);
  await updateEphemeral(iid, token, '✅ Your listing has been bumped!');
}

// ── Modals ────────────────────────────────────────────────────
async function buildAddIsoModal() {
  const ipOpts = await getIpOptions();
  return {
    title:     'Add ISO Item',
    custom_id: 'mp_iso_submit',
    components: [
      // Row 1: IP category select
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'iso_thread',
          placeholder: 'Select IP / brand category…',
          min_values: 1,
          max_values: 1,
          options:     ipOpts,
        }],
      },
      // Row 2: Item name
      {
        type: 1,
        components: [{
          type: 4, custom_id: 'iso_name',
          label: 'Item Name', style: 1,
          placeholder: 'e.g. Jellycat Bashful Bunny Medium',
          required: true, max_length: 200,
        }],
      },
      // Row 3: Max budget
      {
        type: 1,
        components: [{
          type: 4, custom_id: 'iso_budget',
          label: 'Max Budget (USD)', style: 1,
          placeholder: 'e.g. 40.00',
          required: true, max_length: 20,
        }],
      },
      // Row 4: Condition select
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'iso_condition',
          placeholder: 'Select acceptable condition…',
          min_values: 1,
          max_values: 1,
          options:     CONDITION_OPTS,
        }],
      },
      // Row 5: Additional notes (optional paragraph)
      {
        type: 1,
        components: [{
          type: 4, custom_id: 'iso_notes',
          label: 'Additional Notes (optional)', style: 2,
          placeholder: 'Colour variants, size, other requirements…',
          required: false, max_length: 500,
        }],
      },
    ],
  };
}

async function buildRemoveIsoModal(userId) {
  // Build options from all active listings
  const userListings = isoListings[userId] || {};
  const options = [];

  for (const [threadId, listing] of Object.entries(userListings)) {
    for (const item of listing.items) {
      options.push({
        label:       item.name.slice(0, 100),
        value:       `${threadId}::${item.id}`,
        description: item.condition.slice(0, 100),
      });
    }
  }

  if (!options.length) return null; // Signal: nothing to remove

  return {
    title:     'Remove ISO Item',
    custom_id: 'mp_iso_remove',
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: 'iso_remove_select',
        placeholder: 'Select item to remove…',
        min_values: 1,
        max_values: 1,
        options: options.slice(0, 25),
      }],
    }],
  };
}

async function buildEditIsoModal(userId) {
  const userListings = isoListings[userId] || {};
  const options = [];

  for (const [threadId, listing] of Object.entries(userListings)) {
    for (const item of listing.items) {
      options.push({
        label:       item.name.slice(0, 100),
        value:       `${threadId}::${item.id}`,
        description: item.condition.slice(0, 100),
      });
    }
  }

  if (!options.length) return null;

  // Step 1 modal: pick which item to edit
  return {
    title:     'Edit ISO — Select Item',
    custom_id: 'mp_iso_edit_select',
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: 'iso_edit_select',
        placeholder: 'Select item to edit…',
        min_values: 1,
        max_values: 1,
        options: options.slice(0, 25),
      }],
    }],
  };
}

function buildEditFieldsModal(threadId, item) {
  return {
    title:     'Edit ISO Item',
    custom_id: `mp_iso_edit_${threadId}::${item.id}`,
    components: [
      {
        type: 1,
        components: [{
          type: 4, custom_id: 'iso_edit_name',
          label: 'Item Name', style: 1,
          value:       item.name,
          required:    true,
          max_length:  200,
          placeholder: 'e.g. Jellycat Bashful Bunny Medium',
        }],
      },
      {
        type: 1,
        components: [{
          type: 4, custom_id: 'iso_edit_budget',
          label: 'Max Budget (USD)', style: 1,
          value:       item.budget,
          required:    true,
          max_length:  20,
          placeholder: 'e.g. 40.00',
        }],
      },
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'iso_edit_condition',
          placeholder: 'Select condition…',
          min_values: 1, max_values: 1,
          options: CONDITION_OPTS,
        }],
      },
      {
        type: 1,
        components: [{
          type: 4, custom_id: 'iso_edit_notes',
          label: 'Additional Notes (optional)', style: 2,
          value:       item.notes || '',
          required:    false,
          max_length:  500,
          placeholder: 'Colour variants, size, other requirements…',
        }],
      },
    ],
  };
}

// ── Main handler (call this from handleInteraction in marketplace.js) ─
async function handleIsoInteraction(d) {
  const { id, token, type, data, member } = d;
  const userId     = member?.user?.id || d.user?.id;
  const username   = member?.user?.username || d.user?.username;
  const avatarHash = member?.user?.avatar   || d.user?.avatar;
  const avatarUrl  = avatarHash
    ? `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  // ── /setup_iso ─────────────────────────────────────────────
  if (type === 2 && data.name === 'setup_iso') {
    const roles  = member?.roles || [];
    const perms  = BigInt(member?.permissions || '0');
    const isAdmin = roles.includes(ADMIN_ROLE_ID) || roles.includes(BOT_ROLE_ID) || (perms & 8n) === 8n;
    if (!isAdmin) return replyEphemeral(id, token, "❌ You don't have permission.");

    const panelEmbed = {
      color: COLOR,
      title: 'HOT ISOs',
      description: [
        'HOT ISOs are organised by brand and/or IP. Find the ISO category you\'re looking for and leave a comment — hopefully someone will have that item to sell to you soon!',
        '',
        'Remember that these channels are meant to be easily navigable lists. Any general conversation about ISOs should be held in ⁠bazaar-banter.',
        '',
        '**Buyer Guidelines**',
        '• Be specific in what you\'re looking for.',
        '• Include photos when possible.',
        '• Specify price range or any conditions.',
        '• No chatter — we want this forum to be easily searchable so everyone can find what they\'re looking for!',
        '',
        '**Seller Guidelines**',
        '• This thread is only for ISOs. UFS items will be removed.',
        '• If you have someone\'s ISO, tag them in your listing on ⁠member-shops.',
        '• Please do not tag each person more than once — you should assume they\'re not interested if they don\'t respond.',
        '• Do not DM anyone without mutual consent first.',
      ].join('\n'),
    };

    const result = await rest('POST', `/channels/${ISO_FORUM_ID}/threads`, {
      name:    'ISO Board',
      message: {
        embeds:     [panelEmbed],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 1, label: 'Add ISO Item',    custom_id: 'add_iso_item'    },
            { type: 2, style: 4, label: 'Remove Items',    custom_id: 'remove_iso_item' },
            { type: 2, style: 2, label: 'Edit Items',      custom_id: 'edit_iso_item'   },
          ],
        }],
      },
    });

    if (result.id) {
      return replyEphemeral(id, token, `✅ ISO panel created: <#${result.id}>`);
    }
    return replyEphemeral(id, token, '❌ Failed to create ISO panel.');
  }

  // ── "Add ISO Item" button ──────────────────────────────────
  if (type === 3 && data.custom_id === 'add_iso_item') {
    const modal = await buildAddIsoModal();
    return showModal(id, token, modal);
  }

  // ── "Remove Items" button ──────────────────────────────────
  if (type === 3 && data.custom_id === 'remove_iso_item') {
    const modal = await buildRemoveIsoModal(userId);
    if (!modal) return replyEphemeral(id, token, "❌ You don't have any active ISO listings.");
    return showModal(id, token, modal);
  }

  // ── "Edit Items" button ────────────────────────────────────
  if (type === 3 && data.custom_id === 'edit_iso_item') {
    const modal = await buildEditIsoModal(userId);
    if (!modal) return replyEphemeral(id, token, "❌ You don't have any active ISO listings.");
    return showModal(id, token, modal);
  }

  // ── Modal: Add ISO submitted ───────────────────────────────
  if (type === 5 && data.custom_id === 'mp_iso_submit') {
    const comps = data.components.flatMap(r => r.components);
    const get   = (cid) => comps.find(c => c.custom_id === cid);

    const threadId = get('iso_thread')?.values?.[0];
    const name     = get('iso_name')?.value?.trim()   || '';
    const budget   = get('iso_budget')?.value?.trim().replace(/[$,]/g, '') || '';
    const condition = get('iso_condition')?.values?.[0] || '';
    const notes    = get('iso_notes')?.value?.trim()  || '';

    if (!threadId)              return replyEphemeral(id, token, '❌ Please select an IP category.');
    if (!name)                  return replyEphemeral(id, token, '❌ Item name is required.');
    if (isNaN(parseFloat(budget)) || parseFloat(budget) <= 0)
      return replyEphemeral(id, token, '❌ Budget must be a positive number (e.g. 40.00).');
    if (!condition)             return replyEphemeral(id, token, '❌ Please select a condition.');

    const newItem = {
      id:        newItemId(),
      name,
      budget:    parseFloat(budget).toFixed(2),
      condition,
      notes,
      ts:        new Date().toISOString(),
    };

    return upsertIsoListing(id, token, userId, username, avatarUrl, threadId, newItem);
  }

  // ── Modal: Remove ISO item select ──────────────────────────
  if (type === 5 && data.custom_id === 'mp_iso_remove') {
    const comps  = data.components.flatMap(r => r.components);
    const chosen = comps.find(c => c.custom_id === 'iso_remove_select')?.values?.[0];
    if (!chosen) return replyEphemeral(id, token, '❌ No item selected.');

    const [threadId, itemId] = chosen.split('::');
    return removeIsoItem(id, token, userId, username, avatarUrl, threadId, itemId);
  }

  // ── Modal: Edit — pick item ────────────────────────────────
  if (type === 5 && data.custom_id === 'mp_iso_edit_select') {
    const comps  = data.components.flatMap(r => r.components);
    const chosen = comps.find(c => c.custom_id === 'iso_edit_select')?.values?.[0];
    if (!chosen) return replyEphemeral(id, token, '❌ No item selected.');

    const [threadId, itemId] = chosen.split('::');
    const item = isoListings[userId]?.[threadId]?.items?.find(i => i.id === itemId);
    if (!item) return replyEphemeral(id, token, '❌ Item not found.');

    return showModal(id, token, buildEditFieldsModal(threadId, item));
  }

  // ── Modal: Edit — apply fields ─────────────────────────────
  if (type === 5 && data.custom_id?.startsWith('mp_iso_edit_')) {
    const key            = data.custom_id.replace('mp_iso_edit_', '');
    const [threadId, itemId] = key.split('::');
    const comps          = data.components.flatMap(r => r.components);
    const get            = (cid) => comps.find(c => c.custom_id === cid);

    const name      = get('iso_edit_name')?.value?.trim()    || '';
    const budget    = get('iso_edit_budget')?.value?.trim().replace(/[$,]/g, '') || '';
    const condition = get('iso_edit_condition')?.values?.[0] || '';
    const notes     = get('iso_edit_notes')?.value?.trim()   || '';

    if (!name) return replyEphemeral(id, token, '❌ Item name is required.');
    if (isNaN(parseFloat(budget)) || parseFloat(budget) <= 0)
      return replyEphemeral(id, token, '❌ Budget must be a positive number.');

    return editIsoItem(id, token, userId, username, avatarUrl, threadId, itemId, {
      name,
      budget: parseFloat(budget).toFixed(2),
      condition: condition || undefined,
      notes,
    });
  }

  // ── Bump buttons (from DM) ─────────────────────────────────
  if (type === 3 && data.custom_id?.startsWith('iso_bump_dismiss_')) {
    return updateEphemeral(id, token, '👍 No problem — your listing stays as-is.');
  }

  if (type === 3 && data.custom_id?.startsWith('iso_bump_')) {
    // custom_id = iso_bump_{userId}_{threadId}
    const parts    = data.custom_id.split('_');
    // format: iso_bump_<userId>_<threadId>
    // userId & threadId are the last two underscore-segments
    const threadId = parts[parts.length - 1];
    const bumpUser = parts[parts.length - 2];
    return bumpListing(id, token, bumpUser, threadId);
  }

  return false; // Signal: not an ISO interaction
}

// ── Register ISO slash command ────────────────────────────────
async function registerIsoCommand(appId) {
  try {
    await rest('POST', `/applications/${appId}/commands`, {
      name:                        'setup_ISO',
      description:                 'Post the ISO panel',
      default_member_permissions:  '32',
    });
    console.log('ISO slash command registered.');
  } catch (e) {
    console.error('ISO command registration failed:', e.message);
  }
}

module.exports = {
  handleIsoInteraction,
  registerIsoCommand,
  schedulePendingBumps,
};
