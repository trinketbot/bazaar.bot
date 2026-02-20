// ============================================================
// TrinketBot — Marketplace Module (Node.js, discord.js v14 stable)
// ============================================================
// Uses only stable discord.js v14 APIs — no LabelBuilder or
// FileUploadBuilder (those are unreleased). Photos are collected
// as direct uploads into the created thread after posting.
// ============================================================

const {
  Client,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} = require('discord.js');

const fs = require('fs');

// ── Persistent storage ────────────────────────────────────────
const COOLDOWNS_FILE = 'cooldowns.json';
const THREADS_FILE   = 'threads.json';

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let cooldowns = loadJSON(COOLDOWNS_FILE);
let threads   = loadJSON(THREADS_FILE);

// ── Per-user in-progress form state ──────────────────────────
const userState = new Map();

// ── Config ────────────────────────────────────────────────────
const MARKETPLACE_FORUM_ID = '1466105963621777572';
const MARKETPLACE_TAG_IDS = [
  '1466283217496707072', '1466283356701331642', '1466283393732837602',
  '1466283407695806808', '1466283426075115583', '1466283469452873730',
  '1466283480735420488', '1466283506467602472', '1466283529175437364',
  '1466283544480448552', '1466283590080794867', '1466283603565482118',
  '1466283716371288136', '1466283732221820938', '1466283816078278731',
  '1466704594510811270', '1474194075220443166',
];
const DEFAULT_COLOR  = 0xe0ad76;
const COOLDOWN_DAYS  = 14;
const PHOTO_WAIT_MIN = 10; // minutes user has to upload photos to thread

// ── Select option sets ────────────────────────────────────────
const PAYMENT_OPTIONS = [
  { label: 'PayPal G&S', value: 'PayPal G&S' },
  { label: 'Venmo G&S',  value: 'Venmo G&S'  },
  { label: 'Other',      value: 'Other'       },
];
const SHIPPING_OPTIONS = [
  { label: 'Included in price',      value: 'included'   },
  { label: 'Additional (buyer pays)', value: 'additional' },
];
const PACKAGING_OPTIONS = [
  { label: 'Box sealed',         value: 'Box sealed'        },
  { label: 'Box resealed',       value: 'Box resealed'      },
  { label: 'No box',             value: 'No box'            },
  { label: 'Tags attached',      value: 'Tags attached'     },
  { label: 'Tags detached',      value: 'Tags detached'     },
  { label: 'No tags',            value: 'No tags'           },
  { label: 'Other (see notes)',  value: 'Other (see notes)' },
];
const CONDITION_OPTIONS = [
  { label: 'Sealed',            value: 'Sealed'            },
  { label: 'Opened',            value: 'Opened'            },
  { label: 'New',               value: 'New'               },
  { label: 'Other (see notes)', value: 'Other (see notes)' },
];

// ── Helpers ───────────────────────────────────────────────────
function makeOptions(arr) {
  return arr.map(o =>
    new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value)
  );
}

function textRow(customId, label, placeholder, style = TextInputStyle.Short, required = true, maxLength = 200) {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(style)
      .setPlaceholder(placeholder)
      .setMaxLength(maxLength)
      .setRequired(required)
  );
}

// ═════════════════════════════════════════════════════════════
// MODAL BUILDERS
// ═════════════════════════════════════════════════════════════

function buildStep1Modal() {
  return new ModalBuilder()
    .setCustomId('mp_step1')
    .setTitle('Create Listing — Step 1')
    .addComponents(
      textRow('item_count', 'How many items? (1–10)', 'Enter a number from 1 to 10', TextInputStyle.Short, true, 2),
      textRow('general_info', 'Additional general info (optional)', 'e.g. Bundle deals available, ships from NY…', TextInputStyle.Paragraph, false, 500)
    );
}

function buildItemModal(index, total) {
  return new ModalBuilder()
    .setCustomId(`mp_item_${index}`)
    .setTitle(`Item ${index + 1} of ${total} — Details`)
    .addComponents(
      textRow('item_name',  'Item name',           'e.g. Jellycat Bashful Bunny Medium', TextInputStyle.Short,     true,  200),
      textRow('item_price', 'Price (USD)',          'e.g. 35.00',                         TextInputStyle.Short,     true,  20),
      textRow('item_notes', 'Notes (optional)',     'Any extra details about this item',  TextInputStyle.Paragraph, false, 500)
    );
}

function buildPhotoModal() {
  return new ModalBuilder()
    .setCustomId('mp_photos')
    .setTitle('Create Listing — Final Step')
    .addComponents(
      textRow('confirm', 'Type YES to confirm photos show handwritten note',
        'Every photo must show: username, server name, today\'s date',
        TextInputStyle.Short, true, 3)
    );
}

// ═════════════════════════════════════════════════════════════
// VIEW BUILDERS  (ephemeral messages with select menus / buttons)
// ═════════════════════════════════════════════════════════════

function buildPaymentShippingView(state) {
  const paymentMenu = new StringSelectMenuBuilder()
    .setCustomId('mp_payment')
    .setPlaceholder('Payment methods accepted (select 1–3)')
    .setMinValues(1)
    .setMaxValues(3)
    .addOptions(makeOptions(PAYMENT_OPTIONS));

  const shippingMenu = new StringSelectMenuBuilder()
    .setCustomId('mp_shipping')
    .setPlaceholder('Is shipping included or additional?')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(makeOptions(SHIPPING_OPTIONS));

  const continueBtn = new ButtonBuilder()
    .setCustomId('mp_payment_continue')
    .setLabel('Continue')
    .setStyle(ButtonStyle.Primary);

  return {
    content: '**Step 2: Payment & Shipping**\nSelect your options then click **Continue**.',
    components: [
      new ActionRowBuilder().addComponents(paymentMenu),
      new ActionRowBuilder().addComponents(shippingMenu),
      new ActionRowBuilder().addComponents(continueBtn),
    ],
    ephemeral: true,
  };
}

function buildItemConditionView(index, total) {
  const packagingMenu = new StringSelectMenuBuilder()
    .setCustomId(`mp_pkg_${index}`)
    .setPlaceholder(`Item ${index + 1}: Packaging condition`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(makeOptions(PACKAGING_OPTIONS));

  const conditionMenu = new StringSelectMenuBuilder()
    .setCustomId(`mp_cond_${index}`)
    .setPlaceholder(`Item ${index + 1}: Item condition`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(makeOptions(CONDITION_OPTIONS));

  const continueBtn = new ButtonBuilder()
    .setCustomId(`mp_item_cond_continue_${index}`)
    .setLabel('Continue')
    .setStyle(ButtonStyle.Primary);

  return {
    content: `**Item ${index + 1} of ${total}: Conditions**\nSelect both conditions then click **Continue**.`,
    components: [
      new ActionRowBuilder().addComponents(packagingMenu),
      new ActionRowBuilder().addComponents(conditionMenu),
      new ActionRowBuilder().addComponents(continueBtn),
    ],
    ephemeral: true,
  };
}

async function buildTagView(guild) {
  const forum  = guild.channels.cache.get(MARKETPLACE_FORUM_ID);
  const tagMap = {};
  if (forum && forum.availableTags) {
    for (const t of forum.availableTags) tagMap[t.id] = t.name;
  }

  const options = MARKETPLACE_TAG_IDS
    .filter(id => tagMap[id])
    .map(id =>
      new StringSelectMenuOptionBuilder()
        .setLabel(tagMap[id].slice(0, 100))
        .setValue(id)
    );

  if (!options.length) return null;

  const tagMenu = new StringSelectMenuBuilder()
    .setCustomId('mp_tags')
    .setPlaceholder('Select listing tags (at least 1)')
    .setMinValues(1)
    .setMaxValues(Math.min(options.length, 25))
    .addOptions(options);

  const continueBtn = new ButtonBuilder()
    .setCustomId('mp_tags_continue')
    .setLabel('Continue — Add Photos')
    .setStyle(ButtonStyle.Primary);

  return {
    content: '**Select Tags**\nChoose the tags that best describe your items, then click **Continue**.',
    components: [
      new ActionRowBuilder().addComponents(tagMenu),
      new ActionRowBuilder().addComponents(continueBtn),
    ],
    ephemeral: true,
  };
}

// ═════════════════════════════════════════════════════════════
// POST LISTING
// ═════════════════════════════════════════════════════════════

async function postListing(interaction, state) {
  const { userId, user } = state;
  const guild  = interaction.guild;
  const forum  = guild.channels.cache.get(MARKETPLACE_FORUM_ID);

  if (!forum) {
    await interaction.reply({ content: '❌ Marketplace forum not found!', ephemeral: true });
    return;
  }

  // Close previous thread if one exists
  const prevId = threads[userId];
  if (prevId) {
    try {
      const prev = await client.channels.fetch(prevId).catch(() => null);
      if (prev) await prev.edit({ archived: true, locked: true });
    } catch (e) {
      console.error('Could not close old thread:', e.message);
    }
  }

  // Resolve tags
  const tagObjMap = {};
  if (forum.availableTags) {
    for (const t of forum.availableTags) tagObjMap[t.id] = t;
  }
  const appliedTags = (state.tags || []).map(id => tagObjMap[id]).filter(Boolean).slice(0, 5);

  if (!appliedTags.length) {
    await interaction.reply({ content: '❌ None of the selected tags were found. Please contact an admin.', ephemeral: true });
    return;
  }

  const shippingText = state.shipping === 'included' ? 'Included in price' : 'Additional (buyer pays)';

  // Build embed
  const embed = new EmbedBuilder()
    .setTitle(`${user.displayName}'s Shop`)
    .setColor(DEFAULT_COLOR)
    .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
    .setTimestamp();

  for (const [i, item] of state.items.entries()) {
    const lines = [
      `**${item.name}** — $${item.price}`,
      `Packaging: ${item.packaging}  |  Condition: ${item.condition}`,
    ];
    if (item.notes) lines.push(`> ${item.notes}`);
    embed.addFields({ name: `Item ${i + 1}`, value: lines.join('\n'), inline: false });
  }

  embed.addFields(
    { name: 'Payment',  value: state.payment.join(', '), inline: true },
    { name: 'Shipping', value: shippingText,              inline: true },
  );

  if (state.generalInfo) {
    embed.addFields({ name: 'General Info', value: state.generalInfo, inline: false });
  }

  embed.addFields({
    name: '📸 Photos',
    value: `Photos will be posted below by the seller. You have **${PHOTO_WAIT_MIN} minutes** to upload them directly to this thread.`,
    inline: false,
  });

  embed.setFooter({ text: `Seller ID: ${userId}` });

  try {
    const result = await forum.threads.create({
      name: `${user.displayName}'s Shop`,
      message: {
        content: `**${user.toString()}'s Shop Listing**`,
        embeds: [embed],
      },
      appliedTags: appliedTags.map(t => t.id),
    });

    const thread = result;

    // Save state
    threads[userId]   = thread.id;
    cooldowns[userId] = new Date().toISOString();
    saveJSON(THREADS_FILE,   threads);
    saveJSON(COOLDOWNS_FILE, cooldowns);

    userState.delete(userId);

    // Prompt user to upload photos in the thread
    await thread.send(
      `${user.toString()} — your listing has been created! ` +
      `**Please upload your photos directly here** within ${PHOTO_WAIT_MIN} minutes.\n` +
      `Each photo must include a handwritten note with your **username**, **server name**, and **today's date**.\n` +
      `-# If no photos are uploaded, this thread may be removed by a moderator.`
    );

    await interaction.reply({
      content: `✅ Your listing has been created: ${thread.toString()}\nPlease upload your photos there now.`,
      ephemeral: true,
    });

  } catch (e) {
    console.error('Failed to create listing:', e);
    await interaction.reply({ content: `❌ Failed to create listing: ${e.message}`, ephemeral: true });
  }
}

// ═════════════════════════════════════════════════════════════
// CLIENT
// ═════════════════════════════════════════════════════════════

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.InteractionCreate, async interaction => {
  try {
    const userId = interaction.user.id;

    // ── "Create Listing" button (from Python bot's panel) ─────
    if (interaction.isButton() && interaction.customId === 'create_marketplace_listing') {
      if (cooldowns[userId]) {
        const last     = new Date(cooldowns[userId]);
        const diffDays = (Date.now() - last.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays < COOLDOWN_DAYS) {
          const daysLeft = Math.ceil(COOLDOWN_DAYS - diffDays);
          const nextDate = new Date(last.getTime() + COOLDOWN_DAYS * 86400000)
            .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          await interaction.reply({
            content: `❌ You can only create a listing once every ${COOLDOWN_DAYS} days.\nYour next listing is available **${nextDate}** (~${daysLeft} day${daysLeft !== 1 ? 's' : ''}).`,
            ephemeral: true,
          });
          return;
        }
      }
      userState.set(userId, { userId, user: interaction.user, items: [], tags: [] });
      await interaction.showModal(buildStep1Modal());
      return;
    }

    // ── Payment/shipping select menus ─────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'mp_payment') {
      const state = userState.get(userId);
      if (!state) { await interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true }); return; }
      state.payment = interaction.values;
      await interaction.reply({ content: `✅ Payment: **${state.payment.join(', ')}**`, ephemeral: true });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'mp_shipping') {
      const state = userState.get(userId);
      if (!state) { await interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true }); return; }
      state.shipping = interaction.values[0];
      await interaction.reply({ content: `✅ Shipping: **${interaction.values[0] === 'included' ? 'Included in price' : 'Additional (buyer pays)'}**`, ephemeral: true });
      return;
    }

    // ── Payment/shipping Continue button ──────────────────────
    if (interaction.isButton() && interaction.customId === 'mp_payment_continue') {
      const state = userState.get(userId);
      if (!state) { await interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true }); return; }
      if (!state.payment || !state.payment.length) {
        await interaction.reply({ content: '❌ Please select a payment method first.', ephemeral: true }); return;
      }
      if (!state.shipping) {
        await interaction.reply({ content: '❌ Please select a shipping option first.', ephemeral: true }); return;
      }
      // Start item loop
      await interaction.reply(buildItemConditionView(0, state.itemCount));
      return;
    }

    // ── Per-item packaging/condition select menus ─────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mp_pkg_')) {
      const index = parseInt(interaction.customId.split('_')[2], 10);
      const state = userState.get(userId);
      if (!state) { await interaction.reply({ content: '❌ Session expired.', ephemeral: true }); return; }
      state[`pkg_${index}`] = interaction.values[0];
      await interaction.reply({ content: `✅ Packaging: **${interaction.values[0]}**`, ephemeral: true });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mp_cond_')) {
      const index = parseInt(interaction.customId.split('_')[2], 10);
      const state = userState.get(userId);
      if (!state) { await interaction.reply({ content: '❌ Session expired.', ephemeral: true }); return; }
      state[`cond_${index}`] = interaction.values[0];
      await interaction.reply({ content: `✅ Condition: **${interaction.values[0]}**`, ephemeral: true });
      return;
    }

    // ── Per-item condition Continue button ────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('mp_item_cond_continue_')) {
      const index = parseInt(interaction.customId.split('_').pop(), 10);
      const state = userState.get(userId);
      if (!state) { await interaction.reply({ content: '❌ Session expired.', ephemeral: true }); return; }
      if (!state[`pkg_${index}`]) {
        await interaction.reply({ content: '❌ Please select a packaging condition first.', ephemeral: true }); return;
      }
      if (!state[`cond_${index}`]) {
        await interaction.reply({ content: '❌ Please select an item condition first.', ephemeral: true }); return;
      }
      await interaction.showModal(buildItemModal(index, state.itemCount));
      return;
    }

    // ── Tag select menu ───────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'mp_tags') {
      const state = userState.get(userId);
      if (!state) { await interaction.reply({ content: '❌ Session expired.', ephemeral: true }); return; }
      state.tags = interaction.values;

      const forum  = interaction.guild.channels.cache.get(MARKETPLACE_FORUM_ID);
      const tagMap = {};
      if (forum && forum.availableTags) for (const t of forum.availableTags) tagMap[t.id] = t.name;
      const names = state.tags.map(id => tagMap[id] || id).join(', ');
      await interaction.reply({ content: `✅ Tags selected: **${names}**`, ephemeral: true });
      return;
    }

    // ── Tag Continue button ───────────────────────────────────
    if (interaction.isButton() && interaction.customId === 'mp_tags_continue') {
      const state = userState.get(userId);
      if (!state) { await interaction.reply({ content: '❌ Session expired.', ephemeral: true }); return; }
      if (!state.tags || !state.tags.length) {
        await interaction.reply({ content: '❌ Please select at least one tag first.', ephemeral: true }); return;
      }
      await interaction.showModal(buildPhotoModal());
      return;
    }

    // ── Modal submissions ─────────────────────────────────────

    if (!interaction.isModalSubmit()) return;

    const state = userState.get(userId);

    // Step 1 — item count + general info
    if (interaction.customId === 'mp_step1') {
      const count = parseInt(interaction.fields.getTextInputValue('item_count').trim(), 10);
      if (isNaN(count) || count < 1 || count > 10) {
        await interaction.reply({ content: '❌ Please enter a whole number between 1 and 10.', ephemeral: true }); return;
      }
      const newState = {
        userId,
        user: interaction.user,
        itemCount:   count,
        generalInfo: interaction.fields.getTextInputValue('general_info').trim(),
        items:  [],
        tags:   [],
        payment:  null,
        shipping: null,
      };
      userState.set(userId, newState);
      await interaction.reply(buildPaymentShippingView(newState));
      return;
    }

    // Per-item detail modals
    if (interaction.customId.startsWith('mp_item_')) {
      if (!state) { await interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true }); return; }
      const index = parseInt(interaction.customId.split('_')[2], 10);

      const rawPrice = interaction.fields.getTextInputValue('item_price').replace('$', '').replace(',', '').trim();
      const price = parseFloat(rawPrice);
      if (isNaN(price) || price <= 0) {
        await interaction.reply({ content: '❌ Price must be a positive number (e.g. 25.00).', ephemeral: true }); return;
      }

      state.items.push({
        name:      interaction.fields.getTextInputValue('item_name').trim(),
        price:     price.toFixed(2),
        notes:     interaction.fields.getTextInputValue('item_notes').trim(),
        packaging: state[`pkg_${index}`],
        condition: state[`cond_${index}`],
      });

      const next = index + 1;
      if (next < state.itemCount) {
        await interaction.reply(buildItemConditionView(next, state.itemCount));
      } else {
        const tagView = await buildTagView(interaction.guild);
        if (tagView) {
          await interaction.reply(tagView);
        } else {
          // No tags available — skip straight to photo confirmation
          state.tags = [];
          await interaction.showModal(buildPhotoModal());
        }
      }
      return;
    }

    // Final photo confirmation modal
    if (interaction.customId === 'mp_photos') {
      if (!state) { await interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true }); return; }
      const confirm = interaction.fields.getTextInputValue('confirm').trim().toUpperCase();
      if (confirm !== 'YES') {
        await interaction.reply({
          content: '❌ You must type **YES** to confirm every photo includes the required handwritten note.',
          ephemeral: true,
        });
        return;
      }
      await postListing(interaction, state);
      return;
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const method = interaction.replied || interaction.deferred ? 'followUp' : 'reply';
      await interaction[method]({ content: `❌ An unexpected error occurred: ${err.message}`, ephemeral: true });
    } catch { /* already responded */ }
  }
});

client.once(Events.ClientReady, () => {
  console.log(`Marketplace bot ready — logged in as ${client.user.tag}`);
});

client.login(process.env.MARKETPLACE_TOKEN);
