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
const inviteChannelId = (process.env.INVITE_CHANNEL_ID || '').trim();
const privateGuildId = (process.env.PRIVATE_GUILD_ID || '').trim();
const applicationCooldownDays = parseInt(process.env.COOLDOWN_DAYS) || 7;
const cooldownFile = (process.env.COOLDOWN_FILE || 'cooldowns.json').trim();
const allowedRoles = (process.env.ALLOWED_ROLES || '').split(',').map(r => r.trim()).filter(Boolean);
const adminRoles = (process.env.ADMIN_ROLES || '').split(',').map(r => r.trim()).filter(Boolean);

const missingVars = ['TOKEN','CLIENT_ID','GUILD_ID','CHANNEL_ID','STAFF_CHANNEL_ID','INVITE_CHANNEL_ID','PRIVATE_GUILD_ID','ALLOWED_ROLES','ADMIN_ROLES']
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

// threadId -> { applicantId, submitted, ...answers }
const applicationData = {};

// Track in-progress applications to prevent double creation
const inProgress = new Set();

const commands = [
  new SlashCommandBuilder()
    .setName('apply')
    .setDescription('Start the guild application process'),
  new SlashCommandBuilder()
    .setName('accept')
    .setDescription('Accept the applicant in this thread'),
  new SlashCommandBuilder()
    .setName('deny')
    .setDescription('Deny the applicant in this thread'),
  new SlashCommandBuilder()
    .setName('clearcooldown')
    .setDescription("Clear a user's application cooldown")
    .addUserOption(option => option.setName('user').setDescription('User to clear cooldown').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setallowedroles')
    .setDescription('Set roles that can accept or deny applications (admin only)')
    .addRoleOption(option => option.setName('role').setDescription('Role to add').setRequired(true)),
  new SlashCommandBuilder()
    .setName('regeninvite')
    .setDescription('Regenerate a one-time invite link for the applicant in this thread'),
  new SlashCommandBuilder()
    .setName('botmessage')
    .setDescription('Send a message as the bot in a selected channel (admin only)')
    .addChannelOption(option => option.setName('channel').setDescription('Channel to send the message in').setRequired(true))
    .addStringOption(option => option.setName('message').setDescription('Message to send').setRequired(true)),
].map(command => command.toJSON());

async function registerCommands() {
  try {
    console.log('Refreshing slash commands...');
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('Slash commands registered.');
  } catch (error) {
    console.error(error);
  }
}

let applyChannel = null;
let staffChannel = null;

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands();

  try {
    applyChannel = await client.channels.fetch(channelId);
    console.log(`[STARTUP] Apply channel resolved: #${applyChannel.name}`);
  } catch (err) {
    console.error(`[STARTUP] Could not fetch apply channel (${channelId}):`, err.message);
  }

  try {
    staffChannel = await client.channels.fetch(staffChannelId);
    console.log(`[STARTUP] Staff channel resolved: #${staffChannel.name}`);
  } catch (err) {
    console.error(`[STARTUP] Could not fetch staff channel (${staffChannelId}):`, err.message);
  }
});

async function retryDM(user, message, thread, alreadyWarned = false) {
  try {
    const dmChannel = await user.createDM();
    await dmChannel.send(message);
  } catch {
    if (!alreadyWarned) await thread.send(`<@${user.id}>, your DMs are closed. Please open them so we can send you the invite link!`);
    setTimeout(() => retryDM(user, message, thread, true), 10000);
  }
}

client.on('messageCreate', async (message) => {
  if (message.channel.id !== channelId) return;
  if (message.author.bot) return;
  const member = message.guild?.members.cache.get(message.author.id);
  const hasAllowedRole = member?.roles.cache.some(role => allowedRoles.includes(role.id));
  if (hasAllowedRole) return;
  try { await message.delete(); } catch {}
});

function applicationButtons() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modal_identity').setLabel('📝 In-Game Name').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('modal_stats').setLabel('⭐ Gameplay & Stats').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('modal_personal').setLabel('💬 Personal Info').setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modal_other').setLabel('📋 Other Info').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('modal_cheater').setLabel('⚔️ Cheater Experience').setStyle(ButtonStyle.Primary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('submit_application').setLabel('✅ Submit Application').setStyle(ButtonStyle.Success),
  );
  return [row1, row2, row3];
}

function buildApplicationEmbed(data = {}, submitted = false) {
  const val = (key, placeholder) => data[key] ? `\`${data[key]}\`` : `*${placeholder}*`;
  return new EmbedBuilder()
    .setTitle('Ships Guild Application')
    .setColor(submitted ? 0x95a5a6 : 0x2ecc71)
    .setDescription([
      '---', '',
      '**In-Game Name:**',
      val('inGameName', 'Enter your Minecraft in-game name here.'),
      '', '---', '',
      '### Requirements',
      '- **Stars:** 200+',
      '- **FKDR:** 5+',
      '- **Experience with Fighting Cheaters & Snipers:**',
      val('cheaterExp', 'Describe your experience dealing with cheaters and snipers.'),
      '', '---', '',
      '### Gameplay & Stats',
      `**Stars:** ${val('stars', 'How many stars? (Minimum 200)')}`,
      `**FKDR:** ${val('fkdr', 'What is your FKDR? (Minimum 5)')}`,
      `**Favorite Map(s):** ${val('favMaps', 'Which maps do you enjoy most?')}`,
      `**Main Game Mode(s):** ${val('gameModes', 'Bed Wars, Sky Wars, etc.')}`,
      `**How long have you been playing Bed Wars?** ${val('experience', 'Let us know!')}`,
      '', '---', '',
      '### Personal Information',
      '**Why do you want to join Ships?**',
      val('whyJoin', "Tell us why you're interested."),
      '**What makes you a good fit for Ships?**',
      val('goodFit', "Your skills, personality, contributions..."),
      '', '---', '',
      '### Other Information',
      '**Do you have any guild experience?**',
      val('guildExp', 'Tell us about previous guilds.'),
      "**Anything else you'd like us to know?**",
      val('extra', 'Any additional details.'),
      '', '---', '',
      submitted
        ? '✅ **Application submitted! Staff will review it shortly.**'
        : '**Fill out each section above, then click Submit Application when done.**',
    ].join('\n'));
}

function buildStaffEmbed(data, threadId, applicantId) {
  const f = (key) => data[key] || '*Not provided*';
  return new EmbedBuilder()
    .setTitle('📋 New Guild Application')
    .setColor(0x3498db)
    .addFields(
      { name: '👤 In-Game Name', value: f('inGameName'), inline: true },
      { name: '⭐ Stars', value: f('stars'), inline: true },
      { name: '⚔️ FKDR', value: f('fkdr'), inline: true },
      { name: '🗺️ Favorite Maps', value: f('favMaps'), inline: true },
      { name: '🎮 Game Modes', value: f('gameModes'), inline: true },
      { name: '⏱️ BW Experience', value: f('experience'), inline: true },
      { name: '💬 Why Ships?', value: f('whyJoin') },
      { name: '✅ Good Fit?', value: f('goodFit') },
      { name: '🏰 Guild History', value: f('guildExp') },
      { name: '⚙️ Cheater/Sniper Experience', value: f('cheaterExp') },
      { name: '📝 Extra Info', value: f('extra') },
      { name: '🔗 Thread', value: `<#${threadId}>` },
      { name: '🙋 Applicant', value: `<@${applicantId}>` },
    )
    .setTimestamp();
}

function buildModal(customId, title, fields) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  modal.addComponents(...fields.map(f =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(f.id)
        .setLabel(f.label)
        .setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setPlaceholder(f.placeholder || '')
        .setRequired(f.required !== false)
    )
  ));
  return modal;
}

client.on('interactionCreate', async (interaction) => {

  if (interaction.isCommand()) {
    const { commandName } = interaction;

    if (commandName === 'apply') {
      const userId = interaction.user.id;

      // Prevent double-click spam creating two threads
      if (inProgress.has(userId)) {
        return interaction.reply({ content: 'Your application is already being created, please wait!', ephemeral: true });
      }

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

      inProgress.add(userId);

      try {
        await interaction.deferReply({ ephemeral: true });

        // Re-fetch the channel each time to avoid stale cache after thread deletions
        try {
          applyChannel = await client.channels.fetch(channelId);
        } catch {
          inProgress.delete(userId);
          return interaction.editReply({ content: 'Application channel not found. Please contact an admin.' });
        }

        if (!applyChannel) {
          inProgress.delete(userId);
          return interaction.editReply({ content: 'Application channel not found. Please contact an admin.' });
        }

        const thread = await applyChannel.threads.create({
          name: `Application — ${interaction.user.tag}`,
          type: ChannelType.PrivateThread,
          autoArchiveDuration: 1440,
        });

        applicationData[thread.id] = { applicantId: userId, submitted: false };

        cooldowns[userId] = now;
        fs.writeFileSync(cooldownFile, JSON.stringify(cooldowns));

        await thread.send({
          content: `<@${userId}> Welcome! Fill out each section using the buttons below, then click **✅ Submit Application** when you're ready.`,
          embeds: [buildApplicationEmbed({}, false)],
          components: applicationButtons(),
        });

        await interaction.editReply({ content: `Your application thread has been created! Check <#${thread.id}>.` });
      } catch (err) {
        console.error('[APPLY ERROR]', err);
        try { await interaction.editReply({ content: 'Something went wrong. Please try again.' }); } catch {}
      } finally {
        inProgress.delete(userId);
      }
    }

    if (commandName === 'accept' || commandName === 'deny') {
      if (!allowedRoles.some(role => interaction.member.roles.cache.has(role))) {
        return interaction.reply({ content: 'You do not have permission to use this command!', ephemeral: true });
      }

      const thread = interaction.channel;
      const data = thread.isThread() ? applicationData[thread.id] : null;
      // Ensure the staff member is in the thread
      try { await thread.members.add(interaction.user.id); } catch {}

      if (!data) {
        return interaction.reply({ content: 'This command can only be used inside an application thread.', ephemeral: true });
      }

      if (!data.submitted) {
        return interaction.reply({ content: 'This application has not been submitted yet.', ephemeral: true });
      }

      const user = await client.users.fetch(data.applicantId).catch(() => null);

      if (commandName === 'accept') {
        // Generate a one-time invite (1 use, never expires) from the private guild
        let invite = null;
        try {
          const privateGuild = await client.guilds.fetch(privateGuildId);
          const inviteChannel = await privateGuild.channels.fetch(inviteChannelId);
          invite = await inviteChannel.createInvite({
            maxUses: 1,
            maxAge: 0, // 0 = never expires
            unique: true,
            reason: `Guild acceptance for ${user?.tag}`,
          });
        } catch (err) {
          console.error('[INVITE] Failed to create invite:', err.message);
        }

        const inviteUrl = invite ? invite.url : '*(invite generation failed — contact an admin)*';
        if (user) await retryDM(user, `Congratulations! You've been accepted into the Ships guild! Here's your one-time invite link (1 use only):\n${inviteUrl}`, thread);
        await thread.send(`✅ <@${data.applicantId}> has been **accepted** into the guild by <@${interaction.user.id}>!`);
        try {
          try {
            staffChannel = await client.channels.fetch(staffChannelId);
            if (staffChannel) await staffChannel.send({ content: `✅ **Accepted** by <@${interaction.user.id}>`, embeds: [buildStaffEmbed(data, thread.id, data.applicantId)] });
          } catch (err) { console.error('[STAFF CHANNEL] accept error:', err.message); }
        } catch {}
      } else {
        await thread.send(`❌ <@${data.applicantId}> has been **denied** by <@${interaction.user.id}>. You may re-apply after the cooldown period.`);
        try {
          try {
            staffChannel = await client.channels.fetch(staffChannelId);
            if (staffChannel) await staffChannel.send({ content: `❌ **Denied** by <@${interaction.user.id}>`, embeds: [buildStaffEmbed(data, thread.id, data.applicantId)] });
          } catch (err) { console.error('[STAFF CHANNEL] deny error:', err.message); }
        } catch {}
      }

      await interaction.reply({ content: 'Done!', ephemeral: true });
    }

    if (commandName === 'regeninvite') {
      if (!allowedRoles.some(role => interaction.member.roles.cache.has(role))) {
        return interaction.reply({ content: 'You do not have permission to use this command!', ephemeral: true });
      }

      const thread = interaction.channel;
      const data = thread.isThread() ? applicationData[thread.id] : null;

      if (!data) {
        return interaction.reply({ content: 'This command can only be used inside an application thread.', ephemeral: true });
      }

      const user = await client.users.fetch(data.applicantId).catch(() => null);
      if (!user) {
        return interaction.reply({ content: 'Could not find the applicant.', ephemeral: true });
      }
      let invite = null;
      try {
        const privateGuild = await client.guilds.fetch(privateGuildId);
        const inviteChannel = await privateGuild.channels.fetch(inviteChannelId);
        invite = await inviteChannel.createInvite({
          maxUses: 1,
          maxAge: 0,
          unique: true,
          reason: `Invite regenerated for ${user.tag} by ${interaction.user.tag} in thread`,
        });
      } catch (err) {
        console.error('[REGENINVITE] Failed to create invite:', err.message);
        return interaction.reply({ content: 'Failed to generate invite link. Please check bot permissions.', ephemeral: true });
      }

      try {
        const dmChannel = await user.createDM();
        await dmChannel.send(`Your invite link to the Ships guild has been regenerated! Here's your new one-time invite link (1 use only):
${invite.url}`);
        await interaction.reply({ content: `✅ New invite link sent to <@${user.id}> via DM!`, ephemeral: true });
      } catch {
        await interaction.reply({ content: `✅ Generated invite but couldn't DM <@${user.id}> (DMs closed). Link: ${invite.url}`, ephemeral: true });
      }
    }

    if (commandName === 'botmessage') {
      if (!adminRoles.some(role => interaction.member.roles.cache.has(role))) {
        return interaction.reply({ content: 'You do not have permission to use this command!', ephemeral: true });
      }

      const targetChannel = interaction.options.getChannel('channel');
      const message = interaction.options.getString('message');

      try {
        await targetChannel.send(message);
        await interaction.reply({ content: `✅ Message sent in <#${targetChannel.id}>!`, ephemeral: true });
      } catch (err) {
        console.error('[BOTMESSAGE]', err.message);
        await interaction.reply({ content: `❌ Failed to send message. Make sure the bot has access to <#${targetChannel.id}>.`, ephemeral: true });
      }
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

    if (interaction.customId === 'submit_application') {
      if (!data || interaction.user.id !== data.applicantId) {
        return interaction.reply({ content: 'Only the applicant can submit this application.', ephemeral: true });
      }
      if (data.submitted) {
        return interaction.reply({ content: 'You have already submitted your application.', ephemeral: true });
      }

      data.submitted = true;

      const messages = await interaction.channel.messages.fetch({ limit: 20 });
      const botMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
      if (botMsg) {
        await botMsg.edit({ embeds: [buildApplicationEmbed(data, true)], components: [] });
      }

      try {
        try {
          staffChannel = await client.channels.fetch(staffChannelId);
          if (staffChannel) await staffChannel.send({
            content: `📥 **New application submitted!**`,
            embeds: [buildStaffEmbed(data, threadId, data.applicantId)],
          });
        } catch (err) {
          console.error('[STAFF CHANNEL] Failed to post submission:', err.message);
        }
      } catch (err) {
        console.error('[STAFF CHANNEL] Failed to post submission:', err);
      }

      return interaction.reply({ content: '✅ Your application has been submitted! Staff will review it soon.', ephemeral: true });
    }

    if (!data) return;

    if (data.submitted) {
      return interaction.reply({ content: 'This application has already been submitted and can no longer be edited.', ephemeral: true });
    }

    if (interaction.user.id !== data.applicantId) {
      return interaction.reply({ content: 'Only the applicant can fill out this form.', ephemeral: true });
    }

    const modals = {
      modal_identity: () => buildModal('submit_identity', 'In-Game Name', [
        { id: 'inGameName', label: 'Minecraft In-Game Name', placeholder: 'e.g. Notch' },
      ]),
      modal_stats: () => buildModal('submit_stats', 'Gameplay & Stats', [
        { id: 'stars', label: 'Stars (min. 200)', placeholder: 'e.g. 350' },
        { id: 'fkdr', label: 'FKDR (min. 5)', placeholder: 'e.g. 7.2' },
        { id: 'favMaps', label: 'Favorite Map(s)', placeholder: 'e.g. Aqua, Lotus' },
        { id: 'gameModes', label: 'Main Game Mode(s)', placeholder: 'e.g. Doubles, Squads' },
        { id: 'experience', label: 'How long playing Bed Wars?', placeholder: 'e.g. 2 years', long: true },
      ]),
      modal_personal: () => buildModal('submit_personal', 'Personal Information', [
        { id: 'whyJoin', label: 'Why do you want to join Ships?', placeholder: 'Your motivation...', long: true },
        { id: 'goodFit', label: 'What makes you a good fit?', placeholder: 'Skills, personality...', long: true },
      ]),
      modal_other: () => buildModal('submit_other', 'Other Information', [
        { id: 'guildExp', label: 'Previous guild experience?', placeholder: 'Previous guilds...', long: true },
        { id: 'extra', label: 'Anything else to share?', placeholder: 'Optional...', long: true, required: false },
      ]),
      modal_cheater: () => buildModal('submit_cheater', 'Cheater & Sniper Experience', [
        { id: 'cheaterExp', label: 'Experience with cheaters & snipers', placeholder: 'How do you handle them?', long: true },
      ]),
    };

    if (modals[interaction.customId]) {
      return interaction.showModal(modals[interaction.customId]());
    }
  }

  if (interaction.isModalSubmit()) {
    const threadId = interaction.channel.id;
    const data = applicationData[threadId];

    if (!data) return interaction.reply({ content: 'Could not find application data for this thread.', ephemeral: true });

    if (data.submitted) {
      return interaction.reply({ content: 'This application has already been submitted and can no longer be edited.', ephemeral: true });
    }

    const fieldIds = ['inGameName', 'stars', 'fkdr', 'favMaps', 'gameModes', 'experience',
                      'whyJoin', 'goodFit', 'guildExp', 'extra', 'cheaterExp'];

    for (const id of fieldIds) {
      try {
        const val = interaction.fields.getTextInputValue(id);
        if (val) data[id] = val;
      } catch {}
    }

    const messages = await interaction.channel.messages.fetch({ limit: 20 });
    const botMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
    if (botMsg) {
      await botMsg.edit({ embeds: [buildApplicationEmbed(data, false)], components: applicationButtons() });
    }

    await interaction.reply({ content: "✅ Section saved! Click **✅ Submit Application** when you're fully done.", ephemeral: true });
  }
});

client.login(token);