const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('我要開團')
    .setDescription('透過互動選單開團'),

  async execute(interaction) {
    const userId = interaction.user.id;

    const 活動清單 = [
      { label: '10人渡厄煉血堂', value: '10人渡厄煉血堂' },
      { label: '10人幽劫死靈淵', value: '10人幽劫死靈淵' },
      { label: '10人雲沙鎖黃昏', value: '10人雲沙鎖黃昏' },
      { label: '20人渡厄煉血堂', value: '20人渡厄煉血堂' },
      { label: '20人幽劫死靈淵', value: '20人幽劫死靈淵' },
      { label: '20人雲沙鎖黃昏', value: '20人雲沙鎖黃昏' },
      { label: '其它', value: 'custom' }
    ];

    const 難度清單 = [
      { label: '普通', value: '普通' },
      { label: '困難', value: '困難' },
      { label: '噩夢', value: '噩夢' }
    ];

    const row1 = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('select-difficulty')
        .setPlaceholder('請選擇難度')
        .addOptions(難度清單)
    );

    const row2 = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('select-activity')
        .setPlaceholder('請選擇副本')
        .addOptions(活動清單)
    );

    // ⚠️ 一定要抓到「這則回覆訊息」本身，才能在 ephemeral 上收集互動
    const replyMsg = await interaction.reply({
      content: '請選擇副本與難度：',
      components: [row1, row2],
      ephemeral: true,
      fetchReply: true,   // 取得訊息物件
    });

    // ✅ 用「這則回覆訊息」來建立 collector（不是 channel）
    const collector = replyMsg.createMessageComponentCollector({
      filter: i => i.user.id === userId,
      time: 120_000
    });

    let selectedActivity = null;
    let selectedDifficulty = null;

    collector.on('collect', async (i) => {
      try {
        if (i.customId === 'select-activity') {
          selectedActivity = i.values[0];

          if (selectedActivity === 'custom') {
            // 直接 showModal（⚠️ 這裡不要先 defer/reply）
            const modal = new ModalBuilder()
              .setCustomId('modal-custom-activity')
              .setTitle('請輸入自訂副本名稱')
              .addComponents(
                new ActionRowBuilder().addComponents(
                  new TextInputBuilder()
                    .setCustomId('custom-activity')
                    .setLabel('副本名稱')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                )
              );

            await i.showModal(modal);

            // 只接受這位使用者 + 這個 customId 的提交
            const submitted = await i.awaitModalSubmit({
              time: 60_000,
              filter: (m) =>
                m.user.id === userId &&
                m.customId === 'modal-custom-activity'
            }).catch(() => null);

            if (!submitted) return;

            selectedActivity = submitted.fields.getTextInputValue('custom-activity').trim();

            if (selectedDifficulty) {
              await showFinalModal(submitted, selectedActivity, selectedDifficulty);
              collector.stop();
            } else {
              await submitted.reply({ content: `✅ 已輸入：${selectedActivity}，請繼續選擇難度。`, ephemeral: true });
            }
          } else {
            // 已選固定副本
            if (selectedDifficulty) {
              // ✅ 直接開最終 modal（不要先 defer）
              await showFinalModal(i, selectedActivity, selectedDifficulty);
              collector.stop();
            } else {
              // 尚未選難度 → 先 deferUpdate 維持互動不中斷
              await i.deferUpdate();
            }
          }
        }

        if (i.customId === 'select-difficulty') {
          selectedDifficulty = i.values[0];

          if (selectedActivity && selectedActivity !== 'custom') {
            // ✅ 直接開最終 modal（不要先 defer）
            await showFinalModal(i, selectedActivity, selectedDifficulty);
            collector.stop();
          } else {
            // 尚未選副本 → deferUpdate
            await i.deferUpdate();
          }
        }
      } catch (err) {
        console.error('collector error:', err);
        if (!i.deferred && !i.replied) {
          await i.reply({ content: '❌ 發生錯誤，請再試一次。', ephemeral: true });
        }
      }
    });
  }
};

// ✅ 最終輸入 Modal：集合時間＋坦補輸出欄位
async function showFinalModal(interaction, activity, difficulty) {
  // 保險：已被回覆/延後的互動不能再 showModal
  if (interaction.deferred || interaction.replied) {
    try {
      await interaction.followUp?.({ content: '⚠️ 此互動已使用，請重新操作一次。', ephemeral: true });
    } catch {}
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`modal-team-${activity}__${difficulty}__${interaction.id}`)
    .setTitle('輸入集合時間與人數')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('meet-time')
          .setLabel('集合時間（如 2025-08-20 20:00）')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('tank')
          .setLabel('T - 坦人數')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例：2')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('healer')
          .setLabel('N - 奶人數')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例：1')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('dps')
          .setLabel('D - 輸出人數')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例：5')
          .setRequired(true)
      ),
            // 🆕 備註（非必填、多行文字）
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('備註（選填）')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('例：需要進DC、遠程近戰等…')
          .setRequired(false)
          .setMaxLength(500) // 可自行調整上限
      )
    );

  await interaction.showModal(modal);
}
