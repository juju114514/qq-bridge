#!/usr/bin/env node
// 5 分钟看懂这个项目在干什么 —— 不需要 QQ 账号、不需要网关、不联网。
//
// 为什么要有它：
//   别人 clone 下来第一件事是配 QQ / 装网关 / 扫码，任何一步卡住就放弃了。
//   这个脚本用**仓库里真实的模块**跑一遍典型场景，先把"它到底怎么决策"展示出来。
//   看懂了再决定要不要接 QQ。
//
// 用法：npm run demo

import { segmentsToOfficialText, shouldUsePassiveWindow } from '../src/official-transport.js';
import { decideFromOneBot, classifyOneBotPrivate } from '../src/private-access.js';
import { scoreSticker, decideCollect, decideProactiveSend, buildCuratorPrompt } from '../src/sticker-curator.js';
import { emptyStore, upsertStickerNote, STICKER_NOTE_STATUS } from '../src/sticker-notes.js';
import { buildBoundedStickerHint } from '../src/sticker-hint.js';
import { decideGateway, recordProbe } from '../src/gateway-select.js';

const line = (s = '') => console.log(s);
const h1 = (s) => { line(); line('═'.repeat(64)); line(`  ${s}`); line('═'.repeat(64)); };
const h2 = (s) => { line(); line(`── ${s}`); };
const ok = (s) => line(`   ✅ ${s}`);
const no = (s) => line(`   ⛔ ${s}`);
const info = (s) => line(`      ${s}`);

h1('qq-bridge 演示（真实模块，离线运行）');
line('   下面每一行“决策”都是仓库里的真实代码算出来的，不是写死的文案。');

// ── 1. 网关选择 ─────────────────────────────────────────────────────
h2('1. 网关自动选择：SnowLuma 主用，连续失败才降级 NapCat');
let gw = { current: 'snowluma', failStreak: 0, recoverStreak: 0, lastSwitchAt: 0 };
for (let round = 1; round <= 4; round += 1) {
  gw = recordProbe(gw, false);                       // 模拟探测失败
  const d = decideGateway({}, gw);
  info(`第 ${round} 次探测失败 → 继续用 ${d.gateway}（原因：${d.reason}）`);
  if (d.switched) { gw.current = d.gateway; gw.lastSwitchAt = 1e12; }
}
const after = decideGateway({}, { ...gw, recoverStreak: 5, lastSwitchAt: 0 });
ok(`失败 3 次后已降级到 napcat；连续恢复 5 次后回切 ${after.gateway}`);

// ── 2. 消息段降级（官方通道只有文本 / @ / 图片）──────────────────────
h2('2. 同一段消息，两条轨道分别怎么处理');
const segs = [
  { type: 'text', data: { text: '看这个 ' } },
  { type: 'at', data: { qq: 'all' } },
  { type: 'image', data: { url: 'https://example.com/x.png' } },
  { type: 'face', data: { id: '13' } }
];
const official = segmentsToOfficialText(segs);
info(`官方通道：文本 = ${JSON.stringify(official.text)}`);
info(`官方通道：不支持 = ${JSON.stringify(official.unsupported)}（图片单独走富媒体，表情包走富媒体）`);
ok('本地轨道：图片/表情原样发，还能读别人的图');

// ── 3. 私聊准入 ─────────────────────────────────────────────────────
h2('3. 私聊准入：只接好友，临时会话一律拒');
const cases = [
  { label: '好友私聊', ev: { sub_type: 'friend', user_id: '10001' }, ctx: { friends: new Set(['10001']), allowList: [] } },
  { label: '群临时会话', ev: { sub_type: 'group', user_id: '10002' }, ctx: { friends: null, allowList: [] } },
  { label: '白名单强制放行', ev: { sub_type: 'group', user_id: '10003' }, ctx: { friends: null, allowList: ['10003'] } }
];
for (const c of cases) {
  const r = decideFromOneBot({ enabled: true }, c.ev, c.ctx);
  (r.allowed ? ok : no)(`${c.label} → ${r.allowed ? '放行' : '拒绝'}（${r.reason}）`);
}
info('为什么拒临时会话：网关侧"消息能进、回复发不出"，行为极不稳定');

// ── 4. 表情策展 ─────────────────────────────────────────────────────
h2('4. 表情策展：看懂含义 → 判断有没有用 → 决定收/不收/发');
const candidates = [
  { meaning: '无语到翻白眼', tags: ['无语', '怼人'], scope: 'group' },
  { meaning: '', tags: [], scope: 'group' },
  { meaning: '笑死我了', tags: ['笑', '开心'], scope: 'group' }
];
let store = emptyStore();
for (const c of candidates) {
  const score = scoreSticker({ meaning: c.meaning, tags: c.tags });
  const verdict = decideCollect({ score, collectedToday: store.notes.length }, { enabled: true });
  info(`「${c.meaning || '（说不出含义）'}」 score=${score} → ${verdict.collect ? '收藏' : '丢弃'}（${verdict.reason}）`);
  if (verdict.collect) {
    upsertStickerNote(store, { id: `demo-${store.notes.length}`, meaning: c.meaning, tags: c.tags, score,
      status: STICKER_NOTE_STATUS.KEPT, scope: c.scope });
  }
}

h2('   群聊 / 私聊严格隔离（同一份笔记，取用必须带 scope）');
const groupHint = buildBoundedStickerHint(store.notes, 'group');
const privateHint = buildBoundedStickerHint(store.notes, 'private');
info(`群聊提示 = ${JSON.stringify(groupHint)}`);
info(`私聊提示 = ${JSON.stringify(privateHint)}（群里的表情不会串到私聊）`);
info(`不给 scope = ${JSON.stringify(buildBoundedStickerHint(store.notes))}（硬规则：没 scope 就不生效）`);

h2('   主动发表情：相关度 + 每小时配额 + 冷却，三重闸');
const now = 1_000_000;
for (const t of [
  { relevance: 0.3, label: '相关度 0.3' },
  { relevance: 0.9, label: '相关度 0.9（首次）' },
  { relevance: 0.9, sentThisHour: 6, label: '相关度 0.9 但配额用尽' },
  { relevance: 0.9, lastSentAt: now - 60_000, now, label: '相关度 0.9 但刚发过（冷却）' }
]) {
  const r = decideProactiveSend({ ...t, now: t.now ?? now }, { enabled: true });
  (r.send ? ok : no)(`${t.label} → ${r.send ? '发' : '不发'}（${r.reason}）`);
}

h2('   给模型的策展指令（可开关，关掉就不注入）');
buildCuratorPrompt({ enabled: true }).split('\n').forEach((l) => info(l));

// ── 5. 被动回复窗口 ─────────────────────────────────────────────────
h2('5. 官方通道：能被动回复就带 msg_id（5 分钟窗口内、最多 5 条）');
const now2 = 1_000_000;
for (const t of [
  { at: now2 - 30_000, label: '30 秒前有人说话' },
  { at: now2 - 6 * 60_000, label: '6 分钟前（超窗口）' },
  { at: now2 - 30_000, proactive: true, label: '主动播报（强制不带 msg_id）' }
]) {
  const r = shouldUsePassiveWindow({ msgId: 'M', at: t.at }, { now: now2, proactive: t.proactive });
  (r ? ok : no)(`${t.label} → ${r ? '走被动回复' : '只能主动消息'}`);
}

h1('演示结束');
line('   下一步：');
line('     · 想跑起来        → QUICKSTART.md');
line('     · 从 AstrBot 过来 → docs/guides/MIGRATE-FROM-ASTRBOT.md（不用换 NapCat）');
line('     · 卡住了          → docs/运维指南.md（17 节，全是真实事故）');
line();