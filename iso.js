// ============================================================
// TrinketBot — ISO Module
//
// Slash command : /setup_iso
// Buttons       : add_iso_item | remove_iso_item | edit_iso_item
// Modals        : mp_iso_submit | mp_iso_edit_[threadId]
//
// Storage:
//   iso_listings.json — { userId: { threadId: { messageId, content, photoUrls, ts } } }
// ============================================================

const https = require('https');
const fs    = require('fs');

const TOKEN = process.env.MARKETPLACE_TOKEN;
const API   = 'https://discord.com/api/v10';

const httpsAgent = new https.Agent({ keepAlive: true });

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

let isoListings = loadJSON('iso_listings.json');

const ISO_FORUM_ID     = '1466146126330597591';
const ADMIN_ROLE_ID    = '1465161088814289089';
const BOT_ROLE_ID      = '1465163793934848194';
const COLOR            = 0xe0ad76;
const BUMP_COOLDOWN_MS = 72 * 60 * 60 * 1000;

const IPTHREAD_IDS = [
  '1466683002028560498', '1466982282106769451', '1466706222693482597',
  '1466700846166310945', '1466699623082102872', '1466698761844687062',
  '1466696231425413319', '1466693473804746897', '1466692748508794921',
  '1466690531840102440', '1466688832471826569', '1466686206116102429',
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
function showModal(id, token, modal)        { return respond(id, token, 9, modal); }
function replyEphemeral(id, token, content) { return respond(id, token, 4, { content, flags: 64 }); }

// ── Label wrapper (type 18) — same pattern as index.js ───────
let _lid = 100; // start high to avoid collision with index.js ids
function resetIds() { _lid = 100; }
const nextId = () => _lid++;

function label(id, labelText, description, innerComponent) {
  return {
    type: 18, id,
    label: labelText.slice(0, 45),
    description: description?.slice(0, 100),
    component: innerComponent,
  };
}
function textInput(id, placeholder, paragraph = false, required = true, maxLength = 1000) {
  return { type: 4, custom_id: String(id), style: paragraph ? 2 : 1, placeholder, required, max_length: maxLength };
}
function stringSelect(id, placeholder, options, minValues = 1, maxValues = 1) {
  return { type: 3, custom_id: String(id), placeholder, options, min_values: minValues, max_values: maxValues };
}
function fileUpload(id, minValues = 1, maxValues = 5, required = false) {
  return { type: 19, custom_id: String(id), min_values: minValues, max_values: maxValues, required };
}

// ── Resolve IP thread names (cached) ─────────────────────────
let _ipNameCache = null;
async function getIpOptions() {
  if (_ipNameCache) return _ipNameCache;
  const results = await Promise.all(
    IPTHREAD_IDS.map(id =>
      rest('GET', `/channels/${id}`)
        .then(ch => ({ label: (ch.name || id).slice(0, 100), value: id }))
        .catch(() => ({ label: id, value: id }))
    )
  );
  _ipNameCache = results;
  return results;
}

// ── Build ISO embed ───────────────────────────────────────────
function buildIsoEmbed(username, avatarUrl, content, photoUrls) {
  return {
    color:       COLOR,
    author:      { name: `${username}'s ISOs`, icon_url: avatarUrl },
    description: content,
    image:       photoUrls?.[0] ? { url: photoUrls[0] } : undefined,
    footer:      { text: 'Use "Edit Listing" to update or "Remove Listing" to delete' },
    timestamp:   new Date().toISOString(),
  };
}

// ── Upsert listing (delete old + repost = bump) ───────────────
async function upsertIsoListing(iid, token, userId, username, avatarUrl, threadId, content, photoUrls) {
  if (!isoListings[userId]) isoListings[userId] = {};
  const existing = isoListings[userId][threadId];

  if (existing?.ts) {
    const elapsed = Date.now() - new Date(existing.ts).getTime();
    if (elapsed < BUMP_COOLDOWN_MS) {
      const hoursLeft = Math.ceil((BUMP_COOLDOWN_MS - elapsed) / 3600000);
      return replyEphemeral(iid, token,
        `❌ You can only bump your listing once every 72 hours.\n` +
        `Try again in **${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''}**.\n` +
        `Use **Edit Listing** to update your post without bumping.`
      );
    }
    await rest('DELETE', `/channels/${threadId}/messages/${existing.messageId}`).catch(() => {});
  }

  const embed = buildIsoEmbed(username, avatarUrl, content, photoUrls);
  const msg   = await rest('POST', `/channels/${threadId}/messages`, { embeds: [embed] });

  if (!msg.id) return replyEphemeral(iid, token, '❌ Failed to post ISO. Check bot permissions in that thread.');

  isoListings[userId][threadId] = { messageId: msg.id, content, photoUrls: photoUrls || [], ts: new Date().toISOString() };
  saveJSON('iso_listings.json', isoListings);

  return replyEphemeral(iid, token, `✅ Your ISO has been posted in <#${threadId}>!`);
}

// ── Edit listing in place (no bump, no cooldown) ──────────────
async function editIsoListing(iid, token, userId, username, avatarUrl, threadId, content) {
  const listing = isoListings[userId]?.[threadId];
  if (!listing) return replyEphemeral(iid, token, '❌ No listing found. Use "Add ISO Item" instead.');

  const embed = buildIsoEmbed(username, avatarUrl, content, listing.photoUrls);
  await rest('PATCH', `/channels/${threadId}/messages/${listing.messageId}`, { embeds: [embed] });

  listing.content = content;
  saveJSON('iso_listings.json', isoListings);
  return replyEphemeral(iid, token, '✅ Your ISO listing has been updated.');
}

// ── Remove listing ────────────────────────────────────────────
async function removeIsoListing(iid, token, userId, username, avatarUrl, threadId) {
  const listing = isoListings[userId]?.[threadId];
  if (!listing) return replyEphemeral(iid, token, '❌ No listing found in that thread.');

  await rest('DELETE', `/channels/${threadId}/messages/${listing.messageId}`).catch(() => {});
  delete isoListings[userId][threadId];
  saveJSON('iso_listings.json', isoListings);
  return replyEphemeral(iid, token, `✅ Your ISO listing has been removed.`);
}

// ── Modals ────────────────────────────────────────────────────
async function buildAddModal() {
  resetIds();
  const ipOpts = await getIpOptions();

  const l1 = nextId(), inner1 = nextId();
  const l2 = nextId(), inner2 = nextId();
  const l3 = nextId(), inner3 = nextId();

  return {
    title:     'Add ISO',
    custom_id: 'mp_iso_submit',
    components: [
      label(l1, 'IP / Brand Category', 'Select the thread for your ISO',
        stringSelect(inner1, 'Select category…', ipOpts)),
      label(l2, 'What are you looking for?', 'List items, budgets, conditions',
        textInput(inner2,
          'e.g.\nJellycat Bashful Bunny Medium — budget $40, any condition\nSquishmallow Avocado 16" — NWT only, up to $25',
          true, true, 1000)),
      label(l3, 'Photos (optional)', 'Upload up to 5 reference photos',
        fileUpload(inner3, 0, 5, false)),
    ],
  };
}

async function buildEditModal(userId) {
  resetIds();
  const userListings  = isoListings[userId] || {};
  const activeThreads = Object.keys(userListings);
  if (!activeThreads.length) return null;

  const ipOpts = await getIpOptions();
  const opts   = ipOpts.filter(o => activeThreads.includes(o.value));

  const l1 = nextId(), inner1 = nextId();
  const l2 = nextId(), inner2 = nextId();

  // Pre-fill content from first active listing — will update based on which thread they pick
  // Discord doesn't allow dynamic pre-fill based on select, so we use a plain text field
  return {
    title:     'Edit ISO Listing',
    custom_id: 'mp_iso_edit',
    components: [
      label(l1, 'Select Listing to Edit', 'Choose which IP thread to edit',
        stringSelect(inner1, 'Select listing…', opts)),
      label(l2, 'Updated Content', 'Replace your listing with this text',
        textInput(inner2,
          'e.g.\nJellycat Bashful Bunny Medium — budget $40\nSquishmallow Avocado 16" — NWT only',
          true, true, 1000)),
    ],
  };
}

async function buildRemoveModal(userId) {
  resetIds();
  const userListings  = isoListings[userId] || {};
  const activeThreads = Object.keys(userListings);
  if (!activeThreads.length) return null;

  const ipOpts = await getIpOptions();
  const opts   = ipOpts.filter(o => activeThreads.includes(o.value));

  const l1 = nextId(), inner1 = nextId();

  return {
    title:     'Remove ISO Listing',
    custom_id: 'mp_iso_remove',
    components: [
      label(l1, 'Select Listing to Remove', 'This will delete your post in that thread',
        stringSelect(inner1, 'Select listing…', opts)),
    ],
  };
}

// ── Extract fields from modal submit ─────────────────────────
function getFields(components, resolved) {
  const fields = {};
  function walk(comps) {
    for (const c of comps || []) {
      if (c.type === 18 && c.component?.custom_id) {
        const comp = c.component;
        if (comp.type === 19 && comp.values && resolved?.attachments) {
          comp.files = comp.values.map(id => resolved.attachments[id]).filter(Boolean);
        }
        fields[comp.custom_id] = comp;
      }
      if (c.components) walk(c.components);
    }
  }
  walk(components);
  return fields;
}

// ── Main handler ──────────────────────────────────────────────
async function handleIsoInteraction(d) {
  const { id, token, type, data, member } = d;
  const userId     = member?.user?.id       || d.user?.id;
  const username   = member?.user?.username || d.user?.username;
  const avatarHash = member?.user?.avatar   || d.user?.avatar;
  const avatarUrl  = avatarHash
    ? `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  // ── /setup_iso ─────────────────────────────────────────────
  if (type === 2 && data.name === 'setup_iso') {
    const roles   = member?.roles || [];
    const perms   = BigInt(member?.permissions || '0');
    const isAdmin = roles.includes(ADMIN_ROLE_ID) || roles.includes(BOT_ROLE_ID) || (perms & 8n) === 8n;
    if (!isAdmin) return replyEphemeral(id, token, "❌ You don't have permission.");

    const panelEmbed = {
      color: COLOR,
      title: 'HOT ISOs',
      description: [
        "HOT ISOs are organised by brand and/or IP. Find the ISO category you're looking for and leave a comment — hopefully someone will have that item to sell to you soon!",
        '',
        'Remember that these channels are meant to be easily navigable lists. Any general conversation about ISOs should be held in ⁠bazaar-banter.',
        '',
        '**Buyer Guidelines**',
        "• Be specific in what you're looking for.",
        '• Include photos when possible.',
        '• Specify price range or any conditions.',
        "• No chatter — we want this forum to be easily searchable so everyone can find what they're looking for!",
        '',
        '**Seller Guidelines**',
        "• This thread is only for ISOs. UFS items will be removed.",
        "• If you have someone's ISO, tag them in your listing on ⁠member-shops.",
        "• Please do not tag each person more than once — you should assume they're not interested if they don't respond.",
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
            { type: 2, style: 1, label: 'Add ISO Item',   custom_id: 'add_iso_item'    },
            { type: 2, style: 4, label: 'Remove Listing', custom_id: 'remove_iso_item' },
            { type: 2, style: 2, label: 'Edit Listing',   custom_id: 'edit_iso_item'   },
          ],
        }],
      },
    });

    if (result.id) return replyEphemeral(id, token, `✅ ISO panel created: <#${result.id}>`);
    return replyEphemeral(id, token, '❌ Failed to create ISO panel.');
  }

  // ── "Add ISO Item" button ──────────────────────────────────
  if (type === 3 && data.custom_id === 'add_iso_item') {
    const modal = await buildAddModal();
    return showModal(id, token, modal);
  }

  // ── "Edit Listing" button ──────────────────────────────────
  if (type === 3 && data.custom_id === 'edit_iso_item') {
    const modal = await buildEditModal(userId);
    if (!modal) return replyEphemeral(id, token, "❌ You don't have any active ISO listings.");
    return showModal(id, token, modal);
  }

  // ── "Remove Listing" button ────────────────────────────────
  if (type === 3 && data.custom_id === 'remove_iso_item') {
    const modal = await buildRemoveModal(userId);
    if (!modal) return replyEphemeral(id, token, "❌ You don't have any active ISO listings.");
    return showModal(id, token, modal);
  }

  // ── Modal: Add ISO submitted ───────────────────────────────
  if (type === 5 && data.custom_id === 'mp_iso_submit') {
    const fields    = getFields(data.components, data.resolved);
    const comps     = Object.values(fields);
    const selects   = comps.filter(c => c.type === 3);
    const texts     = comps.filter(c => c.type === 4);
    const files     = comps.filter(c => c.type === 19);

    const threadId  = selects[0]?.values?.[0];
    const content   = texts[0]?.value?.trim() || '';
    const photoUrls = (files[0]?.files || []).map(f => f.url);

    if (!threadId) return replyEphemeral(id, token, '❌ Please select an IP category.');
    if (!content)  return replyEphemeral(id, token, "❌ Please describe what you're looking for.");

    return upsertIsoListing(id, token, userId, username, avatarUrl, threadId, content, photoUrls);
  }

  // ── Modal: Edit ISO submitted ──────────────────────────────
  if (type === 5 && data.custom_id === 'mp_iso_edit') {
    const fields   = getFields(data.components, data.resolved);
    const comps    = Object.values(fields);
    const selects  = comps.filter(c => c.type === 3);
    const texts    = comps.filter(c => c.type === 4);

    const threadId = selects[0]?.values?.[0];
    const content  = texts[0]?.value?.trim() || '';

    if (!threadId) return replyEphemeral(id, token, '❌ Please select a listing.');
    if (!content)  return replyEphemeral(id, token, "❌ Please describe what you're looking for.");

    return editIsoListing(id, token, userId, username, avatarUrl, threadId, content);
  }

  // ── Modal: Remove ISO submitted ────────────────────────────
  if (type === 5 && data.custom_id === 'mp_iso_remove') {
    const fields   = getFields(data.components, data.resolved);
    const comps    = Object.values(fields);
    const selects  = comps.filter(c => c.type === 3);
    const threadId = selects[0]?.values?.[0];

    if (!threadId) return replyEphemeral(id, token, '❌ Please select a listing.');
    return removeIsoListing(id, token, userId, username, avatarUrl, threadId);
  }

  return false; // not an ISO interaction
}

async function schedulePendingBumps() {
  // No scheduled bumps — users re-add to bump (72hr cooldown enforced)
}

module.exports = { handleIsoInteraction, schedulePendingBumps };
