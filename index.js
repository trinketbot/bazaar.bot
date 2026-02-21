// ============================================================
// TrinketBot — Marketplace Module
// Built against discord.js main branch (build-from-source).
// Uses LabelBuilder, FileUploadBuilder, and select menus
// inside modals — features not yet in the stable npm release.
//
// FORM FLOW:
//   Button  → Step 1 modal  : item count + general info
//           → Step 2 modal  : payment (select) + shipping (select)
//           → Item modals×N : name + price + notes +
//                             packaging (select) + condition (select)
//           → Tag modal     : tags (select)
//           → Photo modal   : file upload (1-10) + YES confirm
//           → Forum thread posted
// ============================================================

const {
  Client,
  GatewayIntentBits,
  Events,
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
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const fs = require('fs');

// ── Storage ───────────────────────────────────────────────────
function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let cooldowns = loadJSON('cooldowns.json');
let threads   = loadJSON('threads.json');

// Per-user form state
const userState = new Map();

// ── Config ────────────────────────────────────────────────────
const FORUM_ID         = '1466105963621777572';
const PANEL_CHANNEL_ID = '1467358343981961247';
const ADMIN_ROLE_ID    = '1465161088814289089';
const BOT_ROLE_ID      = '1465163793934848194';
const TAG_IDS = [
  '1466283217496707072','1466283356701331642','1466283393732837602',
  '1466283407695806808','1466283426075115583','1466283469452873730',
  '1466283480735420488','1466283506467602472','1466283529175437364',
  '1466283544480448552','1466283590080794867','1466283603565482118',
  '1466283716371288136','1466283732221820938','1466283816078278731',
  '1466704594510811270','1474194075220443166',
];
const COLOR        = 0xe0ad76;
const COOLDOWN_DAYS = 14;

// ── Option sets ───────────────────────────────────────────────
const PAYMENT_OPTS = [
  { label: 'PayPal G&S', value: 'PayPal G&S' },
  { label: 'Venmo G&S',  value: 'Venmo G&S'  },
  { label: 'Other',      value: 'Other'       },
];
const SHIPPING_OPTS = [
  { label: 'Included in price',       value: 'included'   },
  { label: 'Additional (buyer pays)', value: 'additional' },
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

// ── Builder helpers ───────────────────────────────────────────
function opts(arr) {
  return arr.map(o =>
    new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value)
  );
}

function label(labelText, description, component) {
  const lb = new LabelBuilder().setLabel(labelText).setDescription(description);
  if (component instanceof TextInputBuilder)        lb.setTextInputComponent(component);
  else if (component instanceof StringSelectMenuBuilder) lb.setStringSelectMenuComponent(component);
  else if (component instanceof FileUploadBuilder)  lb.setFileUploadComponent(component);
  return lb;
}

// ── Modal builders ────────────────────────────────────────────

function step1Modal() {
  return new ModalBuilder()
    .setCustomId('mp_s1')
    .setTitle('Create Listing — Step 1')
    .addLabelComponents(
      label('How many items? (1–10)', 'Enter a whole number',
        new TextInputBuilder().setCustomId('count').setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 3').setMaxLength(2).setRequired(true)),
      label('General info (optional)', 'Shipping notes, bundle deals, location…',
        new TextInputBuilder().setCustomId('info').setStyle(TextInputStyle.Paragraph)
          .setMaxLength(500).setRequired(false))
    );
}

function step2Modal() {
  return new ModalBuilder()
    .setCustomId('mp_s2')
    .setTitle('Create Listing — Step 2')
    .addLabelComponents(
      label('Payment methods', 'Select all that apply (1–3)',
        new StringSelectMenuBuilder().setCustomId('payment')
          .setMinValues(1).setMaxValues(3).setRequired(true)
          .addOptions(opts(PAYMENT_OPTS))),
      label('Shipping policy', 'Is shipping included or additional?',
        new StringSelectMenuBuilder().setCustomId('shipping')
          .setMinValues(1).setMaxValues(1).setRequired(true)
          .addOptions(opts(SHIPPING_OPTS)))
    );
}

function itemModal(i, total) {
  return new ModalBuilder()
    .setCustomId(`mp_item_${i}`)
    .setTitle(`Item ${i + 1} of ${total}`)
    .addLabelComponents(
      label('Item name', 'Full name of the item',
        new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short)
          .setMaxLength(200).setRequired(true)),
      label('Price (USD)', 'Number only, no $ symbol',
        new TextInputBuilder().setCustomId('price').setStyle(TextInputStyle.Short)
          .setPlaceholder('35.00').setMaxLength(20).setRequired(true)),
      label('Notes (optional)', 'Condition details, flaws, extras',
        new TextInputBuilder().setCustomId('notes').setStyle(TextInputStyle.Paragraph)
          .setMaxLength(500).setRequired(false)),
      label('Packaging condition', 'How is the item packaged?',
        new StringSelectMenuBuilder().setCustomId('packaging')
          .setMinValues(1).setMaxValues(1).setRequired(true)
          .addOptions(opts(PACKAGING_OPTS))),
      label('Item condition', 'What condition is the item itself?',
        new StringSelectMenuBuilder().setCustomId('condition')
          .setMinValues(1).setMaxValues(1).setRequired(true)
          .addOptions(opts(CONDITION_OPTS)))
    );
}

async function tagModal(guild) {
  const forum  = guild.channels.cache.get(FORUM_ID);
  const tagMap = {};
  if (forum?.availableTags) for (const t of forum.availableTags) tagMap[t.id] = t.name;

  const options = TAG_IDS
    .filter(id => tagMap[id])
    .map(id => new StringSelectMenuOptionBuilder().setLabel(tagMap[id].slice(0, 100)).setValue(id));

  if (!options.length) return null;

  return new ModalBuilder()
    .setCustomId('mp_tags')
    .setTitle('Create Listing — Tags')
    .addLabelComponents(
      label('Listing tags', 'Select all tags that describe your items',
        new StringSelectMenuBuilder().setCustomId('tags')
          .setMinValues(1).setMaxValues(Math.min(options.length, 25))
          .setRequired(true).addOptions(options))
    );
}

function photoModal() {
  return new ModalBuilder()
    .setCustomId('mp_photos')
    .setTitle('Create Listing — Photos')
    .addLabelComponents(
      label('Photos (1–10 files)',
        "Each photo must show a handwritten note: username, server name, today's date",
        new FileUploadBuilder().setCustomId('photos')
          .setMinValues(1).setMaxValues(10).setRequired(true)),
      label('Confirm handwritten note',
        'Type YES to confirm every photo includes the required note',
        new TextInputBuilder().setCustomId('confirm').setStyle(TextInputStyle.Short)
          .setPlaceholder('YES').setMinLength(3).setMaxLength(3).setRequired(true))
    );
}

// ── Post listing ──────────────────────────────────────────────
async function postListing(interaction, state) {
  const { userId, user } = state;
  const forum = interaction.guild.channels.cache.get(FORUM_ID);
  if (!forum) {
    return interaction.reply({ content: '❌ Marketplace forum not found.', ephemeral: true });
  }

  // Archive old thread
  if (threads[userId]) {
    try {
      const old = await client.channels.fetch(threads[userId]).catch(() => null);
      if (old) await old.edit({ archived: true, locked: true });
    } catch {}
  }

  // Resolve applied tags
  const tagObjMap = {};
  if (forum.availableTags) for (const t of forum.availableTags) tagObjMap[t.id] = t;
  const appliedTags = (state.tags || []).map(id => tagObjMap[id]).filter(Boolean).slice(0, 5);
  if (!appliedTags.length) {
    return interaction.reply({ content: '❌ None of the selected tags were found.', ephemeral: true });
  }

  const shippingLabel = state.shipping === 'included' ? 'Included in price' : 'Additional (buyer pays)';

  const embed = new EmbedBuilder()
    .setTitle(`${user.displayName}'s Shop`)
    .setColor(COLOR)
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
    { name: 'Shipping', value: shippingLabel,             inline: true },
  );
  if (state.info) embed.addFields({ name: 'General Info', value: state.info, inline: false });

  if (state.photoUrls?.length) {
    const links = state.photoUrls.map((u, i) => `[Photo ${i + 1}](${u})`).join('\n');
    embed.addFields({ name: '📸 Photos', value: links, inline: false });
    embed.setImage(state.photoUrls[0]);
  }

  embed.setFooter({ text: `Seller ID: ${userId}` });

  try {
    const thread = await forum.threads.create({
      name: `${user.displayName}'s Shop`,
      message: { content: `**${user.toString()}'s Shop Listing**`, embeds: [embed] },
      appliedTags: appliedTags.map(t => t.id),
    });

    threads[userId]   = thread.id;
    cooldowns[userId] = new Date().toISOString();
    saveJSON('threads.json',   threads);
    saveJSON('cooldowns.json', cooldowns);
    userState.delete(userId);

    await interaction.reply({ content: `✅ Listing created: ${thread.toString()}`, ephemeral: true });
  } catch (e) {
    console.error('postListing error:', e);
    await interaction.reply({ content: `❌ Failed to create listing: ${e.message}`, ephemeral: true });
  }
}

// ── Client ────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.InteractionCreate, async interaction => {
  try {
    const uid = interaction.user.id;

    // /setup_marketplace slash command
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup_marketplace') {
      const m = interaction.member;
      if (!m.roles.cache.has(ADMIN_ROLE_ID) && !m.roles.cache.has(BOT_ROLE_ID) && !m.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "❌ You don't have permission.", ephemeral: true });
      }
      const ch = interaction.guild.channels.cache.get(PANEL_CHANNEL_ID);
      if (!ch) return interaction.reply({ content: '❌ Panel channel not found.', ephemeral: true });

      const panelEmbed = new EmbedBuilder()
        .setTitle('Marketplace Listings')
        .setDescription(
          'Ready to sell? Click **Create Listing** to build your shop post!\n\n' +
          '**Requirements:**\n' +
          '- Photos must include a handwritten note: username, server name, and today\'s date\n' +
          '- 1–10 photos required\n' +
          '- One listing per **14 days**\n\n' +
          'Creating a new listing will automatically close your previous one.'
        )
        .setColor(COLOR);

      await ch.send({
        embeds: [panelEmbed],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('create_marketplace_listing')
            .setLabel('Create Listing').setStyle(ButtonStyle.Secondary)
        )],
      });
      return interaction.reply({ content: `✅ Panel posted in ${ch.toString()}!`, ephemeral: true });
    }

    // "Create Listing" button
    if (interaction.isButton() && interaction.customId === 'create_marketplace_listing') {
      if (cooldowns[uid]) {
        const diffDays = (Date.now() - new Date(cooldowns[uid]).getTime()) / 86400000;
        if (diffDays < COOLDOWN_DAYS) {
          const daysLeft = Math.ceil(COOLDOWN_DAYS - diffDays);
          const nextDate = new Date(new Date(cooldowns[uid]).getTime() + COOLDOWN_DAYS * 86400000)
            .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return interaction.reply({
            content: `❌ You can only create a listing once every ${COOLDOWN_DAYS} days.\nNext listing available: **${nextDate}** (~${daysLeft} day${daysLeft !== 1 ? 's' : ''}).`,
            ephemeral: true,
          });
        }
      }
      userState.set(uid, { userId: uid, user: interaction.user, items: [], tags: [] });
      return interaction.showModal(step1Modal());
    }

    // All modal submissions
    if (!interaction.isModalSubmit()) return;
    const state = userState.get(uid);

    // Step 1
    if (interaction.customId === 'mp_s1') {
      const count = parseInt(interaction.fields.getTextInputValue('count').trim(), 10);
      if (isNaN(count) || count < 1 || count > 10) {
        return interaction.reply({ content: '❌ Please enter a whole number between 1 and 10.', ephemeral: true });
      }
      userState.set(uid, {
        userId: uid, user: interaction.user,
        itemCount: count,
        info: interaction.fields.getTextInputValue('info').trim(),
        items: [], tags: [], payment: null, shipping: null,
      });
      return interaction.showModal(step2Modal());
    }

    // Step 2
    if (interaction.customId === 'mp_s2') {
      if (!state) return interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true });
      state.payment  = interaction.fields.getStringSelectValues('payment');
      state.shipping = interaction.fields.getStringSelectValues('shipping')[0];
      return interaction.showModal(itemModal(0, state.itemCount));
    }

    // Per-item modals
    if (interaction.customId.startsWith('mp_item_')) {
      if (!state) return interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true });
      const i = parseInt(interaction.customId.split('_')[2], 10);

      const price = parseFloat(
        interaction.fields.getTextInputValue('price').replace(/[$,]/g, '').trim()
      );
      if (isNaN(price) || price <= 0) {
        return interaction.reply({ content: '❌ Price must be a positive number (e.g. 25.00).', ephemeral: true });
      }

      state.items.push({
        name:      interaction.fields.getTextInputValue('name').trim(),
        price:     price.toFixed(2),
        notes:     interaction.fields.getTextInputValue('notes').trim(),
        packaging: interaction.fields.getStringSelectValues('packaging')[0],
        condition: interaction.fields.getStringSelectValues('condition')[0],
      });

      const next = i + 1;
      if (next < state.itemCount) {
        return interaction.showModal(itemModal(next, state.itemCount));
      }
      const tm = await tagModal(interaction.guild);
      return tm ? interaction.showModal(tm) : interaction.showModal(photoModal());
    }

    // Tag modal
    if (interaction.customId === 'mp_tags') {
      if (!state) return interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true });
      state.tags = interaction.fields.getStringSelectValues('tags');
      return interaction.showModal(photoModal());
    }

    // Photo modal
    if (interaction.customId === 'mp_photos') {
      if (!state) return interaction.reply({ content: '❌ Session expired. Please start again.', ephemeral: true });
      if (interaction.fields.getTextInputValue('confirm').trim().toUpperCase() !== 'YES') {
        return interaction.reply({ content: '❌ You must type **YES** to confirm every photo includes the required handwritten note.', ephemeral: true });
      }
      const files = interaction.fields.getUploadedFiles('photos');
      if (!files?.length) {
        return interaction.reply({ content: '❌ Please upload at least one photo.', ephemeral: true });
      }
      state.photoUrls = files.map(f => f.url);
      return postListing(interaction, state);
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const m = interaction.replied || interaction.deferred ? 'followUp' : 'reply';
      await interaction[m]({ content: `❌ An error occurred: ${err.message}`, ephemeral: true });
    } catch {}
  }
});

// ── Slash command registration ────────────────────────────────
async function registerCommands(clientId) {
  const rest = new REST({ version: '10' }).setToken(process.env.MARKETPLACE_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(clientId), {
      body: [
        new SlashCommandBuilder()
          .setName('setup_marketplace')
          .setDescription('Post the marketplace listing panel')
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
          .toJSON(),
      ],
    });
    console.log('Slash commands registered.');
  } catch (e) {
    console.error('Slash command registration failed:', e.message);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Marketplace bot ready — logged in as ${client.user.tag}`);
  await registerCommands(client.user.id);
});

client.login(process.env.MARKETPLACE_TOKEN);
