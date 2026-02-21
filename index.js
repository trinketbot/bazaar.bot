// ============================================================
// TrinketBot — Marketplace Module (Node.js)
// Uses discord.js dev build (discordjs/discord.js on GitHub)
// for modal select menus and file upload support.
//
// FLOW:
//   Button click → Step 1 modal (item count + general info)
//                → Step 2 modal (payment select + shipping select)
//                → Per-item modals × N (name, price, notes,
//                    packaging select, condition select)
//                → Tag modal (tag select)
//                → Photo modal (file upload + confirmation)
//                → Forum thread created
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
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
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
const MARKETPLACE_FORUM_ID         = '1466105963621777572';
const MARKETPLACE_PANEL_CHANNEL_ID = '1467358343981961247';
const ADMIN_ROLE_ID                = '1465161088814289089';
const BOT_ROLE_ID                  = '1465163793934848194';
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

// ── Option sets ───────────────────────────────────────────────
const PAYMENT_OPTIONS = [
  { label: 'PayPal G&S', value: 'PayPal G&S' },
  { label: 'Venmo G&S',  value: 'Venmo G&S'  },
  { label: 'Other',      value: 'Other'       },
];
const SHIPPING_OPTIONS = [
  { label: 'Included in price',       value: 'included'   },
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
function makeSelectOptions(arr) {
  return arr.map(o =>
    new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value)
  );
}

/**
 * Wrap a component in a LabelBuilder with label + description.
 * Used for all modal components (text inputs, selects, file uploads).
 */
function labeled(labelText, description, component) {
  const lb = new LabelBuilder()
    .setLabel(labelText)
    .setDescription(description);

  if (component instanceof TextInputBuilder) {
    lb.setTextInputComponent(component);
  } else if (component instanceof StringSelectMenuBuilder) {
    lb.setStringSelectMenuComponent(component);
  } else if (component instanceof FileUploadBuilder) {
    lb.setFileUploadComponent(component);
  }

  return lb;
}

// ═════════════════════════════════════════════════════════════
// MODAL BUILDERS
// ═════════════════════════════════════════════════════════════

/** Step 1 — item count + general info */
function buildStep1Modal() {
  return new ModalBuilder()
    .setCustomId('mp_step1')
    .setTitle('Create Listing — Step 1 of 3')
    .addLabelComponents(
      labeled(
        'How many items are you selling? (1–10)',
        'Enter a whole number from 1 to 10',
        new TextInputBuilder()
          .setCustomId('item_count')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 3')
          .setMinLength(1)
          .setMaxLength(2)
          .setRequired(true)
      ),
      labeled(
        'Additional general info (optional)',
        'Shipping notes, bundle deals, location, etc.',
        new TextInputBuilder()
          .setCustomId('general_info')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('e.g. Bundle deals available, ships from NY…')
          .setMaxLength(500)
          .setRequired(false)
      )
    );
}

/** Step 2 — payment methods + shipping (selects inside modal) */
function buildStep2Modal() {
  return new ModalBuilder()
    .setCustomId('mp_step2')
    .setTitle('Create Listing — Step 2 of 3')
    .addLabelComponents(
      labeled(
        'Accepted payment methods',
        'Select all that apply (up to 3)',
        new StringSelectMenuBuilder()
          .setCustomId('payment')
          .setPlaceholder('Choose payment methods…')
          .setMinValues(1)
          .setMaxValues(3)
          .setRequired(true)
          .addOptions(makeSelectOptions(PAYMENT_OPTIONS))
      ),
      labeled(
        'Shipping',
        'Is shipping included in your prices or charged separately?',
        new StringSelectMenuBuilder()
          .setCustomId('shipping')
          .setPlaceholder('Select shipping policy…')
          .setMinValues(1)
          .setMaxValues(1)
          .setRequired(true)
          .addOptions(makeSelectOptions(SHIPPING_OPTIONS))
      )
    );
}

/**
 * Per-item modal — name, price, notes + packaging + condition.
 * All five fields in one modal.
 */
function buildItemModal(index, total) {
  const num = index + 1;
  return new ModalBuilder()
    .setCustomId(`mp_item_${index}`)
    .setTitle(`Item ${num} of ${total}`)
    .addLabelComponents(
      labeled(
        'Item name',
        'The full name of the item you are selling',
        new TextInputBuilder()
          .setCustomId('item_name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Jellycat Bashful Bunny Medium')
          .setMaxLength(200)
          .setRequired(true)
      ),
      labeled(
        'Price (USD)',
        'Numeric price — do not include the $ symbol',
        new TextInputBuilder()
          .setCustomId('item_price')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 35.00')
          .setMaxLength(20)
          .setRequired(true)
      ),
      labeled(
        'Additional notes (optional)',
        'Any extra details — required if condition is "Other (see notes)"',
        new TextInputBuilder()
          .setCustomId('item_notes')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('e.g. Minor scuff on ear, barely noticeable')
          .setMaxLength(500)
          .setRequired(false)
      ),
      labeled(
        'Packaging condition',
        'How is the item currently packaged?',
        new StringSelectMenuBuilder()
          .setCustomId('packaging')
          .setPlaceholder('Select packaging condition…')
          .setMinValues(1)
          .setMaxValues(1)
          .setRequired(true)
          .addOptions(makeSelectOptions(PACKAGING_OPTIONS))
      ),
      labeled(
        'Item condition',
        'What condition is the item itself in?',
        new StringSelectMenuBuilder()
          .setCustomId('condition')
          .setPlaceholder('Select item condition…')
          .setMinValues(1)
          .setMaxValues(1)
          .setRequired(true)
          .addOptions(makeSelectOptions(CONDITION_OPTIONS))
      )
    );
}

/** Tag selection modal */
async function buildTagModal(guild) {
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

  // Fallback if no tags resolved
  if (!options.length) return null;

  return new ModalBuilder()
    .setCustomId('mp_tags')
    .setTitle('Create Listing — Tags')
    .addLabelComponents(
      labeled(
        'Listing tags',
        'Select all tags that apply to your listing',
        new StringSelectMenuBuilder()
          .setCustomId('tags')
          .setPlaceholder('Select listing tags…')
          .setMinValues(1)
          .setMaxValues(Math.min(options.length, 25))
          .setRequired(true)
          .addOptions(options)
      )
    );
}

/** Final modal — photo upload + handwritten note confirmation */
function buildPhotoModal() {
  return new ModalBuilder()
    .setCustomId('mp_photos')
    .setTitle('Create Listing — Photos')
    .addLabelComponents(
      labeled(
        'Photos (1–10 files)',
        'Each photo must show a handwritten note: your username, server name, and today\'s date',
        new FileUploadBuilder()
          .setCustomId('photos')
          .setMinValues(1)
          .setMaxValues(10)
          .setRequired(true)
      ),
      labeled(
        'Confirm handwritten note',
        'Type YES to confirm every photo includes the required handwritten note',
        new TextInputBuilder()
          .setCustomId('confirm')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('YES')
          .setMinLength(3)
          .setMaxLength(3)
          .setRequired(true)
      )
    );
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

  // Close previous thread
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
  const appliedTags = (state.tags || [])
    .map(id => tagObjMap[id])
    .filter(Boolean)
    .slice(0, 5);

  if (!appliedTags.length) {
    await interaction.reply({ content: '❌ None of the selected tags were found. Please contact an admin.', ephemeral: true });
    return;
  }

  const shippingText = state.shipping === 'included'
    ? 'Included in price'
    : 'Additional (buyer pays)';

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

  // Photos — CDN URLs from the file upload interaction
  if (state.photoUrls && state.photoUrls.length) {
    const links = state.photoUrls.map((url, i) => `[Photo ${i + 1}](${url})`).join('\n');
    embed.addFields({ name: 'Photos', value: links, inline: false });
    embed.setImage(state.photoUrls[0]);
  }

  embed.setFooter({ text: `Seller ID: ${userId}` });

  try {
    const thread = await forum.threads.create({
      name: `${user.displayName}'s Shop`,
      message: {
        content: `**${user.toString()}'s Shop Listing**`,
        embeds: [embed],
      },
      appliedTags: appliedTags.map(t => t.id),
    });

    threads[userId]   = thread.id;
    cooldowns[userId] = new Date().toISOString();
    saveJSON(THREADS_FILE,   threads);
    saveJSON(COOLDOWNS_FILE, cooldowns);

    userState.delete(userId);

    await interaction.reply({
      content: `✅ Your listing has been created: ${thread.toString()}`,
      ephemeral: true,
    });

  } catch (e) {
    console.error('Failed to create listing:', e);
    await interaction.reply({ content: `❌ Failed to create listing: ${e.message}`, ephemeral: true });
  }
}

// ═════════════════════════════════════════════════════════════
// CLIENT + INTERACTION ROUTER
// ═════════════════════════════════════════════════════════════

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.InteractionCreate, async interaction => {
  try {
    const userId = interaction.user.id;

    // ── /setup_marketplace slash command ──────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup_marketplace') {
      const member     = interaction.member;
      const hasAdmin   = member.roles.cache.has(ADMIN_ROLE_ID);
      const hasBotRole = member.roles.cache.has(BOT_ROLE_ID);
      const isAdmin    = member.permissions.has(PermissionFlagsBits.Administrator);

      if (!hasAdmin && !hasBotRole && !isAdmin) {
        await interaction.reply({ content: "❌ You don't have permission to use this command.", ephemeral: true });
        return;
      }

      const channel = interaction.guild.channels.cache.get(MARKETPLACE_PANEL_CHANNEL_ID);
      if (!channel) {
        await interaction.reply({ content: '❌ Marketplace panel channel not found!', ephemeral: true });
        return;
      }

      const panelEmbed = new EmbedBuilder()
        .setTitle('Marketplace Listings')
        .setDescription(
          'Ready to sell? Click **Create Listing** to build your shop post!\n\n' +
          '**Requirements:**\n' +
          '- Photos must include a handwritten note with your username, server name, and the date\n' +
          '- 1–10 photos required\n' +
          '- Listings can only be created once every **14 days**\n\n' +
          'Creating a new listing will automatically close your previous one.'
        )
        .setColor(DEFAULT_COLOR);

      const panelBtn = new ButtonBuilder()
        .setCustomId('create_marketplace_listing')
        .setLabel('Create Listing')
        .setStyle(ButtonStyle.Secondary);

      await channel.send({
        embeds: [panelEmbed],
        components: [new ActionRowBuilder().addComponents(panelBtn)],
      });

      await interaction.reply({ content: `✅ Marketplace panel posted in ${channel.toString()}!`, ephemeral: true });
      return;
    }

    // ── "Create Listing" button ───────────────────────────────
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

    // ── Modal submissions ─────────────────────────────────────
    if (!interaction.isModalSubmit()) return;

    const state = userState.get(userId);

    // Step 1 — item count + general info
    if (interaction.customId === 'mp_step1') {
      const count = parseInt(interaction.fields.getTextInputValue('item_count').trim(), 10);
      if (isNaN(count) || count < 1 || count > 10) {
        await interaction.reply({ content: '❌ Please enter a whole number between 1 and 10.', ephemeral: true });
        return;
      }
      userState.set(userId, {
        userId,
        user:        interaction.user,
        itemCount:   count,
        generalInfo: interaction.fields.getTextInputValue('general_info').trim(),
        items:       [],
        tags:        [],
        payment:     null,
        shipping:    null,
      });
      await interaction.showModal(buildStep2Modal());
      return;
    }

    // Step 2 — payment + shipping
    if (interaction.customId === 'mp_step2') {
      if (!state) { await interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true }); return; }
      state.payment  = interaction.fields.getStringSelectValues('payment');
      state.shipping = interaction.fields.getStringSelectValues('shipping')[0];
      await interaction.showModal(buildItemModal(0, state.itemCount));
      return;
    }

    // Per-item modals
    if (interaction.customId.startsWith('mp_item_')) {
      if (!state) { await interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true }); return; }
      const index = parseInt(interaction.customId.split('_')[2], 10);

      const rawPrice = interaction.fields.getTextInputValue('item_price').replace('$', '').replace(',', '').trim();
      const price    = parseFloat(rawPrice);
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

      const next = index + 1;
      if (next < state.itemCount) {
        await interaction.showModal(buildItemModal(next, state.itemCount));
      } else {
        const tagModal = await buildTagModal(interaction.guild);
        if (tagModal) {
          await interaction.showModal(tagModal);
        } else {
          // No tags available — skip to photos
          state.tags = [];
          await interaction.showModal(buildPhotoModal());
        }
      }
      return;
    }

    // Tag selection modal
    if (interaction.customId === 'mp_tags') {
      if (!state) { await interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true }); return; }
      state.tags = interaction.fields.getStringSelectValues('tags');
      await interaction.showModal(buildPhotoModal());
      return;
    }

    // Final — photo upload + confirmation
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

      // Extract CDN URLs from uploaded files
      const files = interaction.fields.getUploadedFiles('photos');
      if (!files || files.length === 0) {
        await interaction.reply({ content: '❌ Please upload at least one photo.', ephemeral: true });
        return;
      }

      state.photoUrls = files.map(f => f.url);
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

// ── Slash command registration ────────────────────────────────
async function registerCommands(clientId) {
  const commands = [
    new SlashCommandBuilder()
      .setName('setup_marketplace')
      .setDescription('Post the marketplace listing panel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON(),
  ];
  const rest = new REST({ version: '10' }).setToken(process.env.MARKETPLACE_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Slash commands registered.');
  } catch (e) {
    console.error('Failed to register slash commands:', e.message);
  }
}

// ── Ready ─────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`Marketplace bot ready — logged in as ${client.user.tag}`);
  await registerCommands(client.user.id);
});

client.login(process.env.MARKETPLACE_TOKEN);
