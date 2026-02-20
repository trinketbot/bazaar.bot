// ============================================================
// TrinketBot — Marketplace Module (Node.js)
// Runs as a second bot on Replit alongside the Python bot.
// Intercepts the "create_marketplace_listing" button that the
// Python bot's panel already posts, then handles the full
// listing-creation flow using Discord's newer modal API
// (select menus + file uploads inside modals).
// ============================================================

const {
  Client,
  GatewayIntentBits,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  FileUploadBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuInteraction,
  Events,
  InteractionType,
} = require('discord.js');

// ── GitHub Actions restarts the workflow every 5 hours via the
//    scheduled cron in .github/workflows/bot.yml, so no keep-alive
//    server is needed here.

// ── Configuration ─────────────────────────────────────────────
const MARKETPLACE_FORUM_ID = '1466105963621777572';
const MARKETPLACE_TAG_IDS = [
  '1466283217496707072', '1466283356701331642', '1466283393732837602',
  '1466283407695806808', '1466283426075115583', '1466283469452873730',
  '1466283480735420488', '1466283506467602472', '1466283529175437364',
  '1466283544480448552', '1466283590080794867', '1466283603565482118',
  '1466283716371288136', '1466283732221820938', '1466283816078278731',
  '1466704594510811270', '1474194075220443166',
];

const DEFAULT_COLOR = 0xe0ad76;
const COOLDOWN_DAYS = 14;

// ── In-memory stores (survive restarts via JSON files) ────────
const fs = require('fs');
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

// ── Per-user state (in-memory only, lost on restart — fine for
//    a multi-step form that completes in minutes) ──────────────
/** @type {Map<string, object>} */
const userState = new Map();

// ── Discord client ─────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ═════════════════════════════════════════════════════════════
// CONSTANTS FOR SELECT OPTIONS
// ═════════════════════════════════════════════════════════════
const PAYMENT_OPTIONS = [
  { label: 'PayPal G&S', value: 'PayPal G&S' },
  { label: 'Venmo G&S',  value: 'Venmo G&S'  },
  { label: 'Other',      value: 'Other'       },
];

const SHIPPING_OPTIONS = [
  { label: 'Included in price',           value: 'included'   },
  { label: 'Additional (buyer pays)',      value: 'additional' },
];

const PACKAGING_OPTIONS = [
  { label: 'Box sealed',        value: 'Box sealed'        },
  { label: 'Box resealed',      value: 'Box resealed'      },
  { label: 'No box',            value: 'No box'            },
  { label: 'Tags attached',     value: 'Tags attached'     },
  { label: 'Tags detached',     value: 'Tags detached'     },
  { label: 'No tags',           value: 'No tags'           },
  { label: 'Other (see notes)', value: 'Other (see notes)' },
];

const ITEM_CONDITION_OPTIONS = [
  { label: 'Sealed',            value: 'Sealed'            },
  { label: 'Opened',            value: 'Opened'            },
  { label: 'New',               value: 'New'               },
  { label: 'Other (see notes)', value: 'Other (see notes)' },
];

// ═════════════════════════════════════════════════════════════
// HELPER — build a StringSelectMenu wrapped in a Label
// The new modal API requires: Label → setStringSelectMenuComponent(select)
// then modal.addLabelComponents(label)
// ═════════════════════════════════════════════════════════════
function buildSelectLabel(labelText, description, selectBuilder) {
  return new LabelBuilder()
    .setLabel(labelText)
    .setDescription(description)
    .setStringSelectMenuComponent(selectBuilder);
}

// ═════════════════════════════════════════════════════════════
// MODAL BUILDERS
// ═════════════════════════════════════════════════════════════

/** Step 1 modal — item count + general info */
function buildStep1Modal() {
  const countInput = new TextInputBuilder()
    .setCustomId('item_count')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Enter a number from 1 to 10')
    .setMinLength(1)
    .setMaxLength(2)
    .setRequired(true);

  const infoInput = new TextInputBuilder()
    .setCustomId('general_info')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('e.g. Bundle deals available, ships from NY…')
    .setMaxLength(500)
    .setRequired(false);

  const countLabel = new LabelBuilder()
    .setLabel('How many items are you selling? (1–10)')
    .setTextInputComponent(countInput);

  const infoLabel = new LabelBuilder()
    .setLabel('Additional general info (optional)')
    .setTextInputComponent(infoInput);

  return new ModalBuilder()
    .setCustomId('mp_step1')
    .setTitle('Create Listing — Step 1 of 3')
    .addLabelComponents(countLabel, infoLabel);
}

/** Step 2 modal — payment + shipping (select menus) */
function buildStep2Modal() {
  const paymentSelect = new StringSelectMenuBuilder()
    .setCustomId('payment')
    .setPlaceholder('Choose 1–3 payment methods')
    .setMinValues(1)
    .setMaxValues(3)
    .setRequired(true)
    .addOptions(PAYMENT_OPTIONS.map(o =>
      new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value)
    ));

  const shippingSelect = new StringSelectMenuBuilder()
    .setCustomId('shipping')
    .setPlaceholder('Select shipping policy')
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true)
    .addOptions(SHIPPING_OPTIONS.map(o =>
      new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value)
    ));

  return new ModalBuilder()
    .setCustomId('mp_step2')
    .setTitle('Create Listing — Step 2 of 3')
    .addLabelComponents(
      buildSelectLabel(
        'Accepted payment methods',
        'Select all that apply (up to 3)',
        paymentSelect
      ),
      buildSelectLabel(
        'Shipping',
        'Is shipping included or additional?',
        shippingSelect
      )
    );
}

/**
 * Per-item modal — name, price, notes (text inputs) +
 * packaging condition + item condition (selects)
 * @param {number} index  0-based item index
 * @param {number} total  total item count
 */
function buildItemModal(index, total) {
  const num = index + 1;

  const nameInput = new TextInputBuilder()
    .setCustomId('item_name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Jellycat Bashful Bunny Medium')
    .setMaxLength(200)
    .setRequired(true);

  const priceInput = new TextInputBuilder()
    .setCustomId('item_price')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 35.00')
    .setMaxLength(20)
    .setRequired(true);

  const notesInput = new TextInputBuilder()
    .setCustomId('item_notes')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Any extra details (required if condition is "Other")')
    .setMaxLength(500)
    .setRequired(false);

  const packagingSelect = new StringSelectMenuBuilder()
    .setCustomId('packaging')
    .setPlaceholder('Select packaging condition')
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true)
    .addOptions(PACKAGING_OPTIONS.map(o =>
      new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value)
    ));

  const conditionSelect = new StringSelectMenuBuilder()
    .setCustomId('condition')
    .setPlaceholder('Select item condition')
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true)
    .addOptions(ITEM_CONDITION_OPTIONS.map(o =>
      new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value)
    ));

  return new ModalBuilder()
    .setCustomId(`mp_item_${index}`)
    .setTitle(`Item ${num} of ${total}`)
    .addLabelComponents(
      new LabelBuilder().setLabel('Item name').setTextInputComponent(nameInput),
      new LabelBuilder().setLabel('Price (USD)').setTextInputComponent(priceInput),
      new LabelBuilder().setLabel('Additional notes (optional)').setTextInputComponent(notesInput),
      buildSelectLabel('Packaging condition', 'How is the item packaged?', packagingSelect),
      buildSelectLabel('Item condition', 'What condition is the item in?', conditionSelect)
    );
}

/** Final modal — file upload + handwritten note confirmation */
function buildPhotoModal() {
  const fileUpload = new FileUploadBuilder()
    .setCustomId('photos')
    .setMinValues(1)
    .setMaxValues(10)
    .setRequired(true);

  const confirmInput = new TextInputBuilder()
    .setCustomId('confirm')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Type YES')
    .setMaxLength(3)
    .setRequired(true);

  const photoLabel = new LabelBuilder()
    .setLabel('Photos (1–10)')
    .setDescription('Each photo must show a handwritten note: username, server name, and today\'s date')
    .setFileUploadComponent(fileUpload);

  const confirmLabel = new LabelBuilder()
    .setLabel('Confirm handwritten note in ALL photos')
    .setDescription('Type YES to confirm every photo includes the required handwritten note')
    .setTextInputComponent(confirmInput);

  return new ModalBuilder()
    .setCustomId('mp_photos')
    .setTitle('Create Listing — Final Step')
    .addLabelComponents(photoLabel, confirmLabel);
}

// ═════════════════════════════════════════════════════════════
// TAG SELECTION VIEW
// Sent as an ephemeral message between item modals and photo modal
// ═════════════════════════════════════════════════════════════
async function sendTagView(interaction, userId) {
  const guild  = interaction.guild;
  const forum  = guild.channels.cache.get(MARKETPLACE_FORUM_ID);
  const tagMap = {};

  if (forum && forum.availableTags) {
    for (const tag of forum.availableTags) tagMap[tag.id] = tag.name;
  }

  const options = MARKETPLACE_TAG_IDS
    .filter(id => tagMap[id])
    .map(id =>
      new StringSelectMenuOptionBuilder()
        .setLabel(tagMap[id].slice(0, 100))
        .setValue(id)
    );

  if (!options.length) {
    // No tags found — skip straight to photos
    await interaction.reply({
      content: '⚠️ No listing tags found in the forum — skipping tag step. Click below to add photos.',
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('mp_goto_photos')
            .setLabel('Add Photos & Submit')
            .setStyle(ButtonStyle.Success)
        )
      ],
      ephemeral: true,
    });
    return;
  }

  const tagSelect = new StringSelectMenuBuilder()
    .setCustomId('mp_tags')
    .setPlaceholder('Select listing tags (at least 1)')
    .setMinValues(1)
    .setMaxValues(Math.min(options.length, 25))
    .addOptions(options);

  const continueBtn = new ButtonBuilder()
    .setCustomId('mp_goto_photos')
    .setLabel('Continue — Add Photos')
    .setStyle(ButtonStyle.Primary);

  await interaction.reply({
    content: `**Select Tags for Your Listing**\nChoose the tags that best describe your items, then click **Continue**.`,
    components: [
      new ActionRowBuilder().addComponents(tagSelect),
      new ActionRowBuilder().addComponents(continueBtn),
    ],
    ephemeral: true,
  });
}

// ═════════════════════════════════════════════════════════════
// FINAL — Build and post the forum listing
// ═════════════════════════════════════════════════════════════
async function postListing(interaction, state) {
  const { userId, user } = state;
  const guild  = interaction.guild;
  const forum  = guild.channels.cache.get(MARKETPLACE_FORUM_ID);

  if (!forum) {
    await interaction.reply({ content: '❌ Marketplace forum not found!', ephemeral: true });
    return;
  }

  // Close previous shop thread
  const prevThreadId = threads[userId];
  if (prevThreadId) {
    try {
      const prevThread = await client.channels.fetch(prevThreadId).catch(() => null);
      if (prevThread) await prevThread.edit({ archived: true, locked: true });
    } catch (e) {
      console.error('Could not close old thread:', e.message);
    }
  }

  // Resolve applied tags
  const tagMap = {};
  if (forum.availableTags) {
    for (const tag of forum.availableTags) tagMap[tag.id] = tag;
  }
  const appliedTags = (state.tags || [])
    .map(id => tagMap[id])
    .filter(Boolean)
    .slice(0, 5);

  if (!appliedTags.length) {
    await interaction.reply({ content: '❌ None of the selected tags were found. Please contact an admin.', ephemeral: true });
    return;
  }

  // Build embed
  const shippingText = state.shipping === 'included'
    ? 'Included in price'
    : 'Additional (buyer pays)';

  const embed = new EmbedBuilder()
    .setTitle(`${user.displayName}'s Shop`)
    .setColor(DEFAULT_COLOR)
    .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
    .setTimestamp();

  // Items
  for (const [i, item] of state.items.entries()) {
    const lines = [
      `**${item.name}** — $${item.price}`,
      `Packaging: ${item.packaging}  |  Condition: ${item.condition}`,
    ];
    if (item.notes) lines.push(`> ${item.notes}`);
    embed.addFields({ name: `Item ${i + 1}`, value: lines.join('\n'), inline: false });
  }

  embed.addFields(
    { name: 'Payment',  value: state.payment.join(', '),  inline: true  },
    { name: 'Shipping', value: shippingText,               inline: true  },
  );

  if (state.generalInfo) {
    embed.addFields({ name: 'General Info', value: state.generalInfo, inline: false });
  }

  // Photos — Discord sends CDN attachment URLs in the interaction
  if (state.photoUrls && state.photoUrls.length) {
    const photoLinks = state.photoUrls
      .map((url, i) => `[Photo ${i + 1}](${url})`)
      .join('\n');
    embed.addFields({ name: 'Photos', value: photoLinks, inline: false });
    embed.setImage(state.photoUrls[0]);
  }

  embed.setFooter({ text: `Seller ID: ${userId}` });

  try {
    const threadResult = await forum.threads.create({
      name: `${user.displayName}'s Shop`,
      message: {
        content: `**${user.toString()}'s Shop Listing**`,
        embeds: [embed],
      },
      appliedTags: appliedTags.map(t => t.id),
    });

    // Save cooldown + thread
    threads[userId]   = threadResult.id;
    cooldowns[userId] = new Date().toISOString();
    saveJSON(THREADS_FILE,   threads);
    saveJSON(COOLDOWNS_FILE, cooldowns);

    // Clean up state
    userState.delete(userId);

    await interaction.reply({
      content: `✅ Your listing has been created: ${threadResult.toString()}`,
      ephemeral: true,
    });
  } catch (e) {
    console.error('Failed to create listing:', e);
    await interaction.reply({ content: `❌ Failed to create listing: ${e.message}`, ephemeral: true });
  }
}

// ═════════════════════════════════════════════════════════════
// INTERACTION ROUTER
// ═════════════════════════════════════════════════════════════
client.on(Events.InteractionCreate, async interaction => {
  try {
    // ── Button: "Create Listing" (from Python bot's panel) ──────
    if (interaction.isButton() && interaction.customId === 'create_marketplace_listing') {
      const userId = interaction.user.id;

      // Cooldown check
      if (cooldowns[userId]) {
        const last  = new Date(cooldowns[userId]);
        const diffMs = Date.now() - last.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        if (diffDays < COOLDOWN_DAYS) {
          const daysLeft  = Math.ceil(COOLDOWN_DAYS - diffDays);
          const nextDate  = new Date(last.getTime() + COOLDOWN_DAYS * 86400000);
          const nextStr   = nextDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          await interaction.reply({
            content: `❌ You can only create a listing once every ${COOLDOWN_DAYS} days.\nYour next listing is available **${nextStr}** (in ~${daysLeft} day${daysLeft !== 1 ? 's' : ''}).`,
            ephemeral: true,
          });
          return;
        }
      }

      // Initialise fresh state
      userState.set(userId, { userId, user: interaction.user });
      await interaction.showModal(buildStep1Modal());
      return;
    }

    // ── Button: Go to photos (after tag selection) ───────────────
    if (interaction.isButton() && interaction.customId === 'mp_goto_photos') {
      const state = userState.get(interaction.user.id);
      if (!state) {
        await interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true });
        return;
      }
      await interaction.showModal(buildPhotoModal());
      return;
    }

    // ── Select menu: tag selection ───────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'mp_tags') {
      const state = userState.get(interaction.user.id);
      if (!state) {
        await interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true });
        return;
      }
      state.tags = interaction.values;

      // Resolve display names for confirmation
      const forum  = interaction.guild.channels.cache.get(MARKETPLACE_FORUM_ID);
      const tagMap = {};
      if (forum && forum.availableTags) {
        for (const tag of forum.availableTags) tagMap[tag.id] = tag.name;
      }
      const names = state.tags.map(id => tagMap[id] || id).join(', ');

      await interaction.reply({
        content: `✅ Tags selected: **${names}**\nNow click **Continue — Add Photos** to upload your photos.`,
        ephemeral: true,
      });
      return;
    }

    // ── Modal submissions ────────────────────────────────────────
    if (!interaction.isModalSubmit()) return;

    const userId = interaction.user.id;
    const state  = userState.get(userId) ?? { userId, user: interaction.user };

    // ── Step 1 — item count + general info ──────────────────────
    if (interaction.customId === 'mp_step1') {
      const rawCount = interaction.fields.getTextInputValue('item_count').trim();
      const count    = parseInt(rawCount, 10);

      if (isNaN(count) || count < 1 || count > 10) {
        await interaction.reply({
          content: '❌ Please enter a whole number between 1 and 10.',
          ephemeral: true,
        });
        return;
      }

      state.itemCount   = count;
      state.generalInfo = interaction.fields.getTextInputValue('general_info').trim();
      state.items       = [];
      state.tags        = [];
      userState.set(userId, state);

      await interaction.showModal(buildStep2Modal());
      return;
    }

    // ── Step 2 — payment + shipping ──────────────────────────────
    if (interaction.customId === 'mp_step2') {
      state.payment  = interaction.fields.getStringSelectValues('payment');
      state.shipping = interaction.fields.getStringSelectValues('shipping')[0];
      userState.set(userId, state);

      await interaction.showModal(buildItemModal(0, state.itemCount));
      return;
    }

    // ── Per-item modals — mp_item_0, mp_item_1, … ────────────────
    if (interaction.customId.startsWith('mp_item_')) {
      const index = parseInt(interaction.customId.split('_')[2], 10);

      const rawPrice = interaction.fields.getTextInputValue('item_price')
        .replace('$', '').replace(',', '').trim();
      const price = parseFloat(rawPrice);

      if (isNaN(price) || price <= 0) {
        await interaction.reply({ content: '❌ Price must be a positive number (e.g. 25.00).', ephemeral: true });
        return;
      }

      state.items.push({
        name:      interaction.fields.getTextInputValue('item_name').trim(),
        price:     price.toFixed(2),
        notes:     interaction.fields.getTextInputValue('item_notes').trim(),
        packaging: interaction.fields.getStringSelectValues('packaging')[0],
        condition: interaction.fields.getStringSelectValues('condition')[0],
      });
      userState.set(userId, state);

      const nextIndex = index + 1;
      if (nextIndex < state.itemCount) {
        await interaction.showModal(buildItemModal(nextIndex, state.itemCount));
      } else {
        // All items collected — tag selection
        await sendTagView(interaction, userId);
      }
      return;
    }

    // ── Final modal — photos + confirmation ──────────────────────
    if (interaction.customId === 'mp_photos') {
      const confirm = interaction.fields.getTextInputValue('confirm').trim().toUpperCase();
      if (confirm !== 'YES') {
        await interaction.reply({
          content: '❌ You must type **YES** to confirm every photo includes the required handwritten note.',
          ephemeral: true,
        });
        return;
      }

      // Extract uploaded file CDN URLs from the interaction
      const uploadedFiles = interaction.fields.getUploadedFiles('photos');
      if (!uploadedFiles || uploadedFiles.length === 0) {
        await interaction.reply({ content: '❌ Please upload at least one photo.', ephemeral: true });
        return;
      }

      state.photoUrls = uploadedFiles.map(f => f.url);
      userState.set(userId, state);

      await postListing(interaction, state);
      return;
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const method = interaction.replied || interaction.deferred
        ? 'followUp' : 'reply';
      await interaction[method]({
        content: `❌ An unexpected error occurred: ${err.message}`,
        ephemeral: true,
      });
    } catch { /* already responded */ }
  }
});

// ─────────────────────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log(`Marketplace bot ready — logged in as ${client.user.tag}`);
});

client.login(process.env.MARKETPLACE_TOKEN);
