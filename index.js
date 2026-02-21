// ============================================================
// TrinketBot — Marketplace Module (STABLE VERSION)
// Raw Discord API implementation — no discord.js dependency.
// Properly handles interaction deferring + webhook followups.
// ============================================================

const WebSocket = require('ws');
const https     = require('https');
const fs        = require('fs');

const TOKEN   = process.env.MARKETPLACE_TOKEN;
const API     = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

// ─────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────
function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let cooldowns = loadJSON('cooldowns.json');
let threads   = loadJSON('threads.json');
const userState = new Map();

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const FORUM_ID         = '1466105963621777572';
const PANEL_CHANNEL_ID = '1467358343981961247';
const ADMIN_ROLE_ID    = '1465161088814289089';
const BOT_ROLE_ID      = '1465163793934848194';
const COLOR            = 0xe0ad76;
const COOLDOWN_DAYS    = 14;

// ─────────────────────────────────────────────────────────────
// REST Helper
// ─────────────────────────────────────────────────────────────
function rest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;

    const req = https.request(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
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

// ─────────────────────────────────────────────────────────────
// Interaction Helpers
// ─────────────────────────────────────────────────────────────
function respond(interactionId, token, type, data) {
  return rest(
    'POST',
    `/interactions/${interactionId}/${token}/callback`,
    { type, data }
  );
}

function deferReply(id, token) {
  return respond(id, token, 5); // Deferred response
}

function replyEphemeral(id, token, content) {
  return respond(id, token, 4, { content, flags: 64 });
}

function followup(token, content, ephemeral = true) {
  return rest(
    'POST',
    `/webhooks/${appId}/${token}`,
    { content, ...(ephemeral ? { flags: 64 } : {}) }
  );
}

function showModal(id, token, modal) {
  return respond(id, token, 9, modal);
}

// ─────────────────────────────────────────────────────────────
// Minimal Modal Builders (simplified for clarity)
// ─────────────────────────────────────────────────────────────
function textInput(id, label, placeholder, style = 1, required = true) {
  return {
    type: 1,
    components: [{
      type: 4,
      custom_id: id,
      label,
      style,
      placeholder,
      required
    }]
  };
}

function step1Modal() {
  return {
    custom_id: 'mp_s1',
    title: 'Create Listing — Step 1',
    components: [
      textInput('count', 'How many items? (1–10)', 'e.g. 3')
    ]
  };
}

// ─────────────────────────────────────────────────────────────
// Listing Creation
// ─────────────────────────────────────────────────────────────
async function postListing(id, token, state) {

  await deferReply(id, token); // CRITICAL FIX

  try {
    const result = await rest('POST', `/channels/${FORUM_ID}/threads`, {
      name: `${state.username}'s Shop`,
      message: {
        content: `**<@${state.userId}>'s Shop Listing**`,
        embeds: [{
          title: `${state.username}'s Shop`,
          color: COLOR,
          description: `Items: ${state.itemCount}`,
          timestamp: new Date().toISOString()
        }]
      }
    });

    await followup(token, `✅ Listing created: <#${result.id}>`);

  } catch (err) {
    await followup(token, `❌ Failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Interaction Handler
// ─────────────────────────────────────────────────────────────
async function handleInteraction(d) {

  const { id, token, type, data, member } = d;
  const userId   = member?.user?.id || d.user?.id;
  const username = member?.user?.username || d.user?.username;

  try {

    // ── Slash Command ───────────────────────────────────────
    if (type === 2 && data.name === 'setup_market') {

      await deferReply(id, token); // FIX

      await rest('POST', `/channels/${PANEL_CHANNEL_ID}/messages`, {
        embeds: [{
          title: 'Marketplace Listings',
          description: 'Click below to create listing.',
          color: COLOR
        }],
        components: [{
          type: 1,
          components: [{
            type: 2,
            style: 2,
            label: 'Create Listing',
            custom_id: 'create_listing'
          }]
        }]
      });

      return followup(token, `✅ Panel posted.`);
    }

    // ── Button ──────────────────────────────────────────────
    if (type === 3 && data.custom_id === 'create_listing') {
      userState.set(userId, { userId, username });
      return showModal(id, token, step1Modal());
    }

    // ── Modal Submit ────────────────────────────────────────
    if (type === 5 && data.custom_id === 'mp_s1') {

      const count = parseInt(
        data.components[0].components[0].value,
        10
      );

      if (isNaN(count) || count < 1 || count > 10) {
        return replyEphemeral(id, token, '❌ Must be 1–10.');
      }

      const state = userState.get(userId);
      state.itemCount = count;

      return postListing(id, token, state);
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try { await replyEphemeral(id, token, `❌ Error: ${err.message}`); }
    catch {}
  }
}

// ─────────────────────────────────────────────────────────────
// Gateway
// ─────────────────────────────────────────────────────────────
let heartbeatInterval;
let sequence = null;
let sessionId;
let resumeUrl;
let appId;
let ws;

function connect(url = GATEWAY) {

  ws = new WebSocket(url);

  ws.on('message', async raw => {
    const msg = JSON.parse(raw);
    const { op, d, s, t } = msg;

    if (s) sequence = s;

    if (op === 10) {
      heartbeatInterval = setInterval(() => {
        ws.send(JSON.stringify({ op: 1, d: sequence }));
      }, d.heartbeat_interval);

      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: TOKEN,
          intents: 1 << 0,
          properties: { os: 'linux', browser: 'bot', device: 'bot' }
        }
      }));
    }

    if (op === 0) {

      if (t === 'READY') {
        sessionId = d.session_id;
        resumeUrl = d.resume_gateway_url;
        appId     = d.application.id;
        console.log(`Bot ready as ${d.user.username}`);
      }

      if (t === 'INTERACTION_CREATE') {
        console.log('Interaction:', d.type, d.data?.name || d.data?.custom_id);
        await handleInteraction(d);
      }
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeatInterval);
    setTimeout(() => connect(resumeUrl || GATEWAY), 5000);
  });
}

connect();
