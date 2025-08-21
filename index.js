const fs = require('fs');
const path = require('path');
const {
  Client,
  Collection,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

// 載入指令
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.warn(`⚠️ 指令 ${file} 缺少 data 或 execute，已略過`);
  }
}


// Bot 上線
client.once('ready', () => {
  console.log(`✅ Bot 上線為 ${client.user.tag}`);
});

// === Modal 處理：開團表單提交後建立頻道與報名卡 ===
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (command) await command.execute(interaction);
  }

  if (!interaction.isModalSubmit()) return;
  const [prefix, modalType] = interaction.customId.split('-');
  if (prefix !== 'modal' || modalType !== 'team') return;

  const meetTime = interaction.fields.getTextInputValue('meet-time')?.trim();
  const tank = parseInt(interaction.fields.getTextInputValue('tank')?.trim() || '0', 10);
  const healer = parseInt(interaction.fields.getTextInputValue('healer')?.trim() || '0', 10);
  const dps = parseInt(interaction.fields.getTextInputValue('dps')?.trim() || '0', 10);

  if ([tank, healer, dps].some(n => isNaN(n) || n < 0 || n > 20)) {
    await interaction.reply({ content: '❌ 請輸入 0~20 之間的數字作為人數！', ephemeral: true });
    return;
  }

const opener = interaction.user;
const guild = interaction.guild;
const note = interaction.fields.getTextInputValue('note')?.trim() || '';

const [activity, difficulty] = interaction.customId
  .replace('modal-team-', '')
  .split('__');

const dateOnly = meetTime.split(' ')[0];
const channelName = `🟢${dateOnly}-${difficulty}${activity}`.slice(0, 100);

// 先找出指定分類
const category = guild.channels.cache.find(
  ch => ch.type === ChannelType.GuildCategory && ch.name === '開團專區'
);

const createdChannel = await guild.channels.create({
  name: channelName,
  type: ChannelType.GuildText,
  topic: `開團者：${opener.username} | 活動時間：${meetTime}${note ? ` | 備註：${note.slice(0, 60)}…` : ''}`,
  parent: category?.id ?? null, // 如果找不到分類就不設定 parent
  permissionOverwrites: [
    {
      id: guild.roles.everyone,
      allow: [PermissionFlagsBits.ViewChannel],
    }
  ]
});

// 先建三個基本欄位
const fields = [
  { name: `🛡️ 坦 (0/${tank})`, value: '（尚未有人報名）', inline: true },
  { name: `💊 奶 (0/${healer})`, value: '（尚未有人報名）', inline: true },
  { name: `🗡️ 輸出 (0/${dps})`, value: '（尚未有人報名）', inline: true },
];

// 有備註才加
if (note) {
  fields.push({
    name: '📝 備註',
    value: note.slice(0, 1024),   // Discord 單欄位 value 最多 1024 字
    inline: false
  });
}

const embed = {
  title: `📣 ${difficulty} | ${activity} 開團報名卡`,
  description: `## 🕙 集合時間：**${meetTime}**\n👥 需求職位：**坦 ${tank} / 奶 ${healer} / 輸出 ${dps}**\n\n請點擊下方按鈕報名！`,
  color: 0x66ccff,
  footer: { text: `開團者：${interaction.member?.displayName || opener.tag}` },
  timestamp: new Date().toISOString(),
  fields, // ← 用上面動態組好的 fields
  image: { url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3384260/header.jpg' }
};

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('join-tank')
      .setLabel('🛡️ 坦')
      .setStyle(ButtonStyle.Danger),   // 紅色

    new ButtonBuilder()
      .setCustomId('join-heal')
      .setLabel('💊 奶')
      .setStyle(ButtonStyle.Success),  // 綠色

    new ButtonBuilder()
      .setCustomId('join-dps')
      .setLabel('🗡️ 輸出')
      .setStyle(ButtonStyle.Primary),  // 藍色

    new ButtonBuilder()
      .setCustomId('cancel-signup')
      .setLabel('❌ 取消報名')
      .setStyle(ButtonStyle.Secondary) // 灰色（或 Danger 紅色也可）
  );

  const openerName = interaction.member ? interaction.member.displayName : opener.username;
  const openerMention = `<@${opener.id}>`;
  const message = await createdChannel.send({
    content: `@here 👋 ${openerMention} 開了一團 ${difficulty}${activity}！歡迎報名～`,
    embeds: [embed],
    components: [row]
  });

  await interaction.reply({
    content: `✅ 已建立頻道 <#${createdChannel.id}> 並發送報名卡片！`,
    ephemeral: true
  });
});

// === 即時更新報名邏輯 ===
// 使用 Map 記憶每張報名卡的報名資料（以 messageId 為 key）
// 使用 Map 記憶報名資料與上限


const signups = new Map();

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const message = interaction.message;
  const messageId = message.id;
  const userId = interaction.user.id;

  // 初始化報名資料
  if (!signups.has(messageId)) {
    signups.set(messageId, {
      tank: new Set(),
      healer: new Set(),
      dps: new Set(),
      tankQueue: [],
      healerQueue: [],
      dpsQueue: [],
      users: new Map(), // userId → role 或 roleQueue
      limits: { tank: 0, healer: 0, dps: 0 }
    });
  }

  const signup = signups.get(messageId);

  // 首次報名解析上限
  if (signup.limits.tank === 0 && signup.limits.healer === 0 && signup.limits.dps === 0) {
    const desc = message.embeds[0]?.description || '';
    const match = desc.match(/坦\s*(\d+)\s*\/\s*奶\s*(\d+)\s*\/\s*輸出\s*(\d+)/);
    if (match) {
      signup.limits.tank = parseInt(match[1], 10);
      signup.limits.healer = parseInt(match[2], 10);
      signup.limits.dps = parseInt(match[3], 10);
    }
  }

  // === 取消報名 ===
  if (interaction.customId === 'cancel-signup') {
    if (!signup.users.has(userId)) {
      await interaction.reply({ content: '⚠️ 你尚未報名任何職位。', flags: 64 });
      return;
    }

    const prevRole = signup.users.get(userId);
    signup.users.delete(userId);

    if (prevRole.endsWith('Queue')) {
      signup[prevRole] = signup[prevRole].filter(id => id !== userId);
    } else {
      signup[prevRole].delete(userId);

      const queueKey = `${prevRole}Queue`;
      const nextUserId = signup[queueKey]?.shift();
      if (nextUserId) {
        signup[prevRole].add(nextUserId);
        signup.users.set(nextUserId, prevRole);
        try {
          const member = await interaction.guild.members.fetch(nextUserId);
          await member.send(`✅ 你已從 **${prevRole} 候補**遞補為正取，請前往報名頻道查看！`);
        } catch {}
      }
    }

    await updateSignupMessage(interaction, message, signup);
    await interaction.reply({ content: '✅ 你已取消報名。', flags: 64 });
    return;
  }

  // === 職位按鈕報名 ===
  const roleMap = {
    'join-tank': 'tank',
    'join-heal': 'healer',
    'join-dps': 'dps'
  };
  const selectedRole = roleMap[interaction.customId];
  if (!selectedRole) return;

  // 檢查是否已報名（正取或候補）
  if (signup.users.has(userId)) {
    const existingRole = signup.users.get(userId);
    if (existingRole === selectedRole) {
      return await interaction.reply({
        content: `⚠️ 你已經報名為 ${selectedRole === 'tank' ? '坦' : selectedRole === 'healer' ? '奶' : '輸出'}，無需重複報名。`,
        flags: 64
      });
    }

    // 取消原報名
    if (existingRole.endsWith('Queue')) {
      signup[existingRole] = signup[existingRole].filter(id => id !== userId);
    } else {
      signup[existingRole].delete(userId);
    }
    signup.users.delete(userId);
  }

  // 額滿則加入候補
  if (signup[selectedRole].size >= signup.limits[selectedRole]) {
    const queueKey = `${selectedRole}Queue`;
    if (!signup[queueKey].includes(userId)) {
      signup[queueKey].push(userId);
      signup.users.set(userId, queueKey);
      await updateSignupMessage(interaction, message, signup);
      return await interaction.reply({
        content: `⚠️ ${selectedRole === 'tank' ? '坦' : selectedRole === 'healer' ? '奶' : '輸出'}人數已滿，你已加入候補名單！`,
        flags: 64
      });
    } else {
      return await interaction.reply({ content: '⚠️ 你已在候補名單中。', flags: 64 });
    }
  }

  // 正取報名
  signup[selectedRole].add(userId);
  signup.users.set(userId, selectedRole);
  await updateSignupMessage(interaction, message, signup);

  await interaction.reply({
    content: `✅ 你已報名為 **${selectedRole === 'tank' ? 'T-坦' : selectedRole === 'healer' ? 'N-奶' : 'D-輸出'}**！`,
    ephemeral: true
  });
});



// 登入
client.login(process.env.TOKEN);




async function updateSignupMessage(interaction, message, signup) {
  const countText = (role, set) => `(${set.size}/${signup.limits[role]})`;

  const format = (set) =>
    set.size ? [...set].map(id => `<@${id}>`).join('\n') : '（尚未有人報名）';

  const formatQueue = (queue) =>
    queue.length ? `🔁 候補：${queue.map(id => `<@${id}>`).join('、')}` : '';

  const updatedEmbed = {
    ...message.embeds[0].data,
    fields: [
      {
        name: `🛡️ 坦 ${countText('tank', signup.tank)}`,
        value: format(signup.tank) + (signup.tankQueue.length ? `\n${formatQueue(signup.tankQueue)}` : ''),
        inline: true
      },
      {
        name: `💊 奶 ${countText('healer', signup.healer)}`,
        value: format(signup.healer) + (signup.healerQueue.length ? `\n${formatQueue(signup.healerQueue)}` : ''),
        inline: true
      },
      {
        name: `🗡️ 輸出 ${countText('dps', signup.dps)}`,
        value: format(signup.dps) + (signup.dpsQueue.length ? `\n${formatQueue(signup.dpsQueue)}` : ''),
        inline: true
      }
    ]
  };

  await message.edit({ embeds: [updatedEmbed], components: message.components });
}
