const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const fs = require('fs');

const token = (process.env.TOKEN || '').trim();
const clientId = (process.env.CLIENT_ID || '').trim();
const guildId = (process.env.GUILD_ID || '').trim();
const channelId = (process.env.CHANNEL_ID || '').trim();
const staffChannelId = (process.env.STAFF_CHANNEL_ID || '').trim();
const inviteLink = (process.env.INVITE_LINK || '').trim();
const applicationCooldownDays = parseInt(process.env.COOLDOWN_DAYS) || 7;
const cooldownFile = (process.env.COOLDOWN_FILE || 'cooldowns.json').trim();
const allowedRoles = (process.env.ALLOWED_ROLES || '').split(',').map(r => r.trim()).filter(Boolean);
const adminRoles = (process.env.ADMIN_ROLES || '').split(',').map(r => r.trim()).filter(Boolean);

const missingVars = ['TOKEN','CLIENT_ID','GUILD_ID','CHANNEL_ID','STAFF_CHANNEL_ID','INVITE_LINK','ALLOWED_ROLES','ADMIN_ROLES']
  .filter(k => !process.env[k] || !process.env[k].trim());
if (missingVars.length > 0) {
  console.error(`[STARTUP ERROR] Missing env vars: ${missingVars.join(', ')}`);
  process.exit(1);
}
console.log(`[STARTUP] CHANNEL_ID="${channelId}" STAFF_CHANNEL_ID="${staffChannelId}"`);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

const rest = new REST({ version: '9' }).setToken(token);

let cooldowns = {};
if (fs.existsSync(cooldownFile)) {
  cooldowns = JSON.parse(fs.readFileSync(cooldownFile));
}

const applicationData = {};

const commands = [
  new SlashCommandBuilder().setName('apply').setDescription('Start the guild application process'),
  new SlashCommandBuilder()
    .setName('accept')
    .setDescription('Accept a guild applicant')
    .addUserOption(option => option.setName('user').setDescription('The user to accept').setRequired(true)),
  new SlashCommandBuilder()
    .setName('deny')
    .setDescription('Deny a guild applicant')
    .addUserOption(option => option.setName('user').setDescription('The user to deny').setRequired(true)),
  new SlashCommandBuilder()
    .setName('clearcooldown')
    .setDescription("Clear a user's application cooldown")
    .addUserOption(option => option.setName('user').setDescription('User to clear cooldown').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setallowedroles')
    .setDescription('Set roles that can accept or deny applications (admin only)')
    .addRoleOption(option => option.setName('role').setDescription('Role to add').setRequired(true)),
].map(command => command.toJSON());

async function registerCommands() {
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands();
});

async function retryDM(user, message, thread, alreadyWarned = false) {
  const warningMessage = `<@${user.id}>, it seems like your DMs are closed. Please open them so we can send you the invite link!`;
  try {
    const dmChannel = await user.createDM();
    await dmChannel.send(message);
    console.log(`Successfully sent DM to ${user.tag}`);
  } catch (err) {
    if (!alreadyWarned) {
      console.log(`User ${user.tag} has DMs disabled. Retrying...`);
      await thread.send(warningMessage);
    }
    setTimeout(() => retryDM(user, message, thread, true), 10000);
  }
}

client.on('messageCreate', async (message) => {
  if (message.channel.id !== channelId) return;
  if (message.author.bot) return;
  const member = message.guild?.members.cache.get(message.author.id);
  const hasAllowedRole = member?.roles.cache.some(role => allowedRoles.includes(role.id));
  if (hasAllowedRole) return;
  try {
    await message.delete();
  } catch (error) {
    console.error('Failed to delete message:', error);
  }
});

function buildApplicationMessage(data = {}) {
  const val = (key, placeholder) => data[key] ? `\`${data[key]}\`` : `*${placeholder}*`;

  const embed = new EmbedBuilder()
    .setTitle('Ships Guild Application')
    .setColor(0x2ecc71)
    .setDescription(
      [
        '---',
        '',
        '**In-Game Name:**',
        val('inGameName', 'Enter your Minecraft in-game name here.'),
        '',
        '---',
        '',
        '### Requirements',
        '- **Stars:** 200+',
        '- **FKDR:** 5+',
        '- **Experience with Fighting Cheaters & Snipers:**',
        val('cheaterExp', 'We need players who know how to handle cheaters and snipers. Describe your experience.'),
        '',
        '---',
        '',
        '### Gameplay & Stats',
        `**Stars:** ${val('stars', 'How many stars do you have? (Minimum 200)')}`,
        `**FKDR:** ${val('fkdr', 'What is your FKDR? (Minimum 5)')}`,
        `**Favorite Map(s):** ${val('favMaps', 'Which maps do you enjoy playing on the most?')}`,
        `**Main Game Mode(s):** ${val('gameModes', 'Bed Wars, Sky Wars, etc.')}`,
        `**How long have you been playing Bed Wars?** ${val('experience', 'Let us know your experience!')}`,
        '',
        '---',
        '',
        '### Personal Information',
        '**Why do you want to join Ships?**',
        val('whyJoin', "Tell us why you're interested in becoming a member."),
        '**What makes you a good fit for Ships?**',
        val('goodFit', "Give us an idea of your skills, personality, and how you'd contribute."),
        '',
        '---',
        '',
        '### Other Information',
        '**Do you have any guild experience?**',
        val('guildExp', 'If yes, tell us about your previous guilds.'),
        "**Anything else you'd like us to know?**",
        val('extra', 'Feel free to share any additional details.'),
        '',
        '---',
        '',
        '**Best of luck with your application!**',
        'We will review your stats and application, and get back to you soon.',
      ].join('\n')
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modal_identity').setLabel('📝 In-Game Name').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('modal_stats').setLabel('⭐ Gameplay & Stats').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('modal_personal').setLabel('💬 Personal Info').setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modal_other').setLabel('📋 Other Info').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('modal_cheater').setLabel('⚔️ Cheater Experience').setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

function buildStaffEmbed(data, threadId, applicantId) {
  const field = (key, fallback) => data[key] || fallback;

  return new EmbedBuilder()
    .setTitle('📋 New Guild Application')
    .setColor(0x3498db)
    .addFields(
      { name: '👤 In-Game Name', value: field('inGameName', '*Not provided*'), inline: true },
      { name: '⭐ Stars', value: field('stars', '*Not provided*'), inline: true },
      { name: '⚔️ FKDR', value: field('fkdr', '*Not provided*'), inline: true },
      { name: '🗺️ Favorite Maps', value: field('favMaps', '*Not provided*'), inline: true },
      { name: '🎮 Game Modes', value: field('gameModes', '*Not provided*'), inline: true },
      { name: '⏱️ BW Experience', value: field('experience', '*Not provided*'), inline: true },
      { name: '💬 Why Ships?', value: field('whyJoin', '*Not provided*') },
      { name: '✅ Good Fit?', value: field('goodFit', '*Not provided*') },
      { name: '🏰 Guild History', value: field('guildExp', '*Not provided*') },
      { name: '⚙️ Cheater/Sniper Experience', value: field('cheaterExp', '*Not provided*') },
      { name: '📝 Extra Info', value: field('extra', '*Not provided*') },
      { name: '🔗 Application Thread', value: `<#${threadId}>` },
      { name: '🙋 Applicant', value: `<@${applicantId}>` },
    )
    .setTimestamp();
}

function buildModal(customId, title, fields) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  const rows = fields.map(f =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(f.id)
        .setLabel(f.label)
        .setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setPlaceholder(f.placeholder || '')
        .setRequired(f.required !== false)
    )
  );
  modal.addComponents(...rows);
  return modal;
}

client.on('interactionCreate', async (interaction) => {

  if (interaction.isCommand()) {
    const { commandName } = interaction;

    if (commandName === 'apply') {
      let applyChannel;
      try {
        applyChannel = await interaction.guild.channels.fetch(channelId);
      } catch (err) {
        console.error('[APPLY] Failed to fetch apply channel:', err);
        return interaction.reply({ content: 'Could not find the application channel. Please contact an admin.', ephemeral: true });
      }

      if (!applyChannel) {
        return interaction.reply({ content: 'Application channel not found. Please contact an admin.', ephemeral: true });
      }

      const userId = interaction.user.id;
      const now = Date.now();
      const cooldownMs = applicationCooldownDays * 24 * 60 * 60 * 1000;
      const cooldownTimestamp = cooldowns[userId];

      if (cooldownTimestamp && now - cooldownTimestamp < cooldownMs) {
        const daysLeft = Math.ceil((cooldownMs - (now - cooldownTimestamp)) / (1000 * 60 * 60 * 24));
        return interaction.reply({
          content: `You have already applied! Please wait **${daysLeft} days** before applying again.`,
          ephemeral: true,
        });
      }

      cooldowns[userId] = now;
      fs.writeFileSync(cooldownFile, JSON.stringify(cooldowns));

      const thread = await applyChannel.threads.create({
        name: `Application — ${interaction.user.tag}`,
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 1440,
      });

      applicationData[thread.id] = { applicantId: userId };

      await thread.send({
        content: `<@${userId}> Welcome! Fill out each section below using the buttons. Click a button to open the form for that section.`,
        ...buildApplicationMessage(),
      });

      await interaction.reply({ content: `Your application thread has been created! Check <#${thread.id}>.`, ephemeral: true });
    }

    if (commandName === 'accept' || commandName === 'deny') {
      if (!allowedRoles.some(role => interaction.member.roles.cache.has(role))) {
        return interaction.reply({ content: 'You do not have permission to use this command!', ephemeral: true });
      }

      const thread = interaction.channel;
      const isApplicationThread = thread.isThread() && applicationData[thread.id];

      if (!isApplicationThread) {
        return interaction.reply({ content: 'This command can only be used inside an application thread.', ephemeral: true });
      }

      const user = interaction.options.getUser('user');
      const data = applicationData[thread.id];

      if (user.id !== data.applicantId) {
        return interaction.reply({ content: 'That user is not the applicant for this thread.', ephemeral: true });
      }

      if (commandName === 'accept') {
        const msg = `Congratulations! You've been accepted into the Ships guild! Here's your invite: ${inviteLink}`;
        await retryDM(user, msg, thread);
        await thread.send(`✅ <@${user.id}> has been **accepted** into the guild by <@${interaction.user.id}>!`);

        try {
          const staffChannel = await interaction.guild.channels.fetch(staffChannelId);
          if (staffChannel) await staffChannel.send({ content: `✅ **Accepted** by <@${interaction.user.id}>`, embeds: [buildStaffEmbed(data, thread.id, user.id)] });
        } catch (_) {}

      } else {
        await thread.send(`❌ <@${user.id}> has been **denied** by <@${interaction.user.id}>. You may re-apply after the cooldown period.`);

        try {
          const staffChannel = await interaction.guild.channels.fetch(staffChannelId);
          if (staffChannel) await staffChannel.send({ content: `❌ **Denied** by <@${interaction.user.id}>`, embeds: [buildStaffEmbed(data, thread.id, user.id)] });
        } catch (_) {}
      }

      await interaction.reply({ content: 'Done!', ephemeral: true });
    }

    if (commandName === 'clearcooldown') {
      if (!allowedRoles.some(role => interaction.member.roles.cache.has(role))) {
        return interaction.reply({ content: 'You do not have permission to use this command!', ephemeral: true });
      }
      const user = interaction.options.getUser('user');
      if (!cooldowns[user.id]) {
        return interaction.reply({ content: `${user.tag} has no active cooldown.`, ephemeral: true });
      }
      delete cooldowns[user.id];
      fs.writeFileSync(cooldownFile, JSON.stringify(cooldowns));
      interaction.reply({ content: `Cooldown cleared for ${user.tag}.`, ephemeral: true });
    }

    if (commandName === 'setallowedroles') {
      if (!adminRoles.some(role => interaction.member.roles.cache.has(role))) {
        return interaction.reply({ content: 'You do not have permission to use this command!', ephemeral: true });
      }
      const role = interaction.options.getRole('role');
      if (!allowedRoles.includes(role.id)) {
        allowedRoles.push(role.id);
        interaction.reply({ content: `${role.name} can now accept/deny applications!`, ephemeral: true });
      } else {
        interaction.reply({ content: 'This role is already allowed!', ephemeral: true });
      }
    }
  }

  if (interaction.isButton()) {
    const threadId = interaction.channel.id;
    const data = applicationData[threadId];

    if (data && interaction.user.id !== data.applicantId) {
      return interaction.reply({ content: 'Only the applicant can fill out this form.', ephemeral: true });
    }

    if (interaction.customId === 'modal_identity') {
      return interaction.showModal(buildModal('submit_identity', 'In-Game Name', [
        { id: 'inGameName', label: 'Minecraft In-Game Name', placeholder: 'e.g. Notch' },
      ]));
    }

    if (interaction.customId === 'modal_stats') {
      return interaction.showModal(buildModal('submit_stats', 'Gameplay & Stats', [
        { id: 'stars', label: 'Stars (min. 200)', placeholder: 'e.g. 350' },
        { id: 'fkdr', label: 'FKDR (min. 5)', placeholder: 'e.g. 7.2' },
        { id: 'favMaps', label: 'Favorite Map(s)', placeholder: 'e.g. Aqua, Lotus' },
        { id: 'gameModes', label: 'Main Game Mode(s)', placeholder: 'e.g. Doubles, Squads' },
        { id: 'experience', label: 'How long playing Bed Wars?', placeholder: 'e.g. 2 years', long: true },
      ]));
    }

    if (interaction.customId === 'modal_personal') {
      return interaction.showModal(buildModal('submit_personal', 'Personal Information', [
        { id: 'whyJoin', label: 'Why do you want to join Ships?', placeholder: 'Tell us your motivation...', long: true },
        { id: 'goodFit', label: 'What makes you a good fit?', placeholder: 'Skills, personality, contributions...', long: true },
      ]));
    }

    if (interaction.customId === 'modal_other') {
      return interaction.showModal(buildModal('submit_other', 'Other Information', [
        { id: 'guildExp', label: 'Previous guild experience?', placeholder: 'Name of guilds, what you learned...', long: true },
        { id: 'extra', label: 'Anything else to share?', placeholder: 'Optional extra info...', long: true, required: false },
      ]));
    }

    if (interaction.customId === 'modal_cheater') {
      return interaction.showModal(buildModal('submit_cheater', 'Cheater & Sniper Experience', [
        { id: 'cheaterExp', label: 'Experience handling cheaters & snipers', placeholder: 'How do you handle them?', long: true },
      ]));
    }
  }

  if (interaction.isModalSubmit()) {
    const threadId = interaction.channel.id;
    if (!applicationData[threadId]) applicationData[threadId] = {};
    const data = applicationData[threadId];

    const fieldIds = ['inGameName', 'stars', 'fkdr', 'favMaps', 'gameModes', 'experience',
                      'whyJoin', 'goodFit', 'guildExp', 'extra', 'cheaterExp'];

    for (const id of fieldIds) {
      try {
        const val = interaction.fields.getTextInputValue(id);
        if (val) data[id] = val;
      } catch (_) {}
    }

    const messages = await interaction.channel.messages.fetch({ limit: 10 });
    const botMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);

    if (botMsg) {
      await botMsg.edit(buildApplicationMessage(data));
    }

    // Post summary to staff channel once application has at least an IGN
    if (data.inGameName) {
      try {
        const staffChannel = await interaction.guild.channels.fetch(staffChannelId);
        if (staffChannel) {
          const staffMessages = await staffChannel.messages.fetch({ limit: 50 });
          const existing = staffMessages.find(m =>
            m.author.id === client.user.id &&
            m.embeds[0]?.fields?.some(f => f.name === '🔗 Application Thread' && f.value === `<#${threadId}>`)
          );
          const payload = { embeds: [buildStaffEmbed(data, threadId, data.applicantId)] };
          if (existing) {
            await existing.edit(payload);
          } else {
            await staffChannel.send(payload);
          }
        }
      } catch (err) {
        console.error('[STAFF CHANNEL] Failed to post/update summary:', err);
      }
    }

    await interaction.reply({ content: '✅ Section saved! The application has been updated.', ephemeral: true });
  }
});

client.login(token);
