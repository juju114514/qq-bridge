// 官方通道「主动消息」的契约测试：cron / 配额 / 权限降级 / 接线，全离线。
//
// 主动消息是唯一会"打扰用户"的出口，闸门写错就是封号级事故，所以逐条钉住。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const m = await import(new URL('../src/official-proactive.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

// ── 1. cron ─────────────────────────────────────────────────────────────
check('parseCron：*/5、范围、列表、步长都支持', () => {
  const c = m.parseCron('*/5 9-18 1,15 * 1-5');
  assert.ok(c.minutes.has(0) && c.minutes.has(55) && !c.minutes.has(3));
  assert.ok(c.hours.has(9) && c.hours.has(18) && !c.hours.has(19));
  assert.ok(c.doms.has(1) && c.doms.has(15) && !c.doms.has(2));
  assert.ok(c.dows.has(1) && c.dows.has(5) && !c.dows.has(0));
});

check('parseCron：段数/越界/非法步长要报错，不能静默当 0', () => {
  assert.throws(() => m.parseCron('* * *'), /5 段/);
  assert.throws(() => m.parseCron('60 * * * *'), /越界/);
  assert.throws(() => m.parseCron('*/0 * * * *'), /步长/);
});

check('cronMatches：分钟/小时/月/周都参与；日与周同时限定时按"或"', () => {
  const d = new Date(2026, 9, 29, 9, 5); // 2026-10-29 09:05 周四
  assert.equal(m.cronMatches('5 9 * * *', d), true);
  assert.equal(m.cronMatches('6 9 * * *', d), false);
  assert.equal(m.cronMatches('5 9 * * 4', d), true, '周四命中 dow=4');
  assert.equal(m.cronMatches('5 9 1 * 4', d), true, '日不匹配但周匹配 → 或');
  assert.equal(m.cronMatches('5 9 29 10 *', d), true);
  assert.equal(m.cronMatches('5 9 * 11 *', d), false);
});

check('isDue：同一分钟只跑一次；disabled 不跑；坏 cron 不炸', () => {
  const now = new Date(2026, 9, 29, 9, 5);
  const s = { key: 'group:official-X', cron: '*/1 * * * *', enabled: true };
  assert.equal(m.isDue(s, now), true);
  s.lastRunStamp = '2026-10-29 9:5';
  assert.equal(m.isDue(s, now), false, '同一分钟不能重复触发');
  assert.equal(m.isDue({ ...s, lastRunStamp: '', enabled: false }, now), false);
  assert.equal(m.isDue({ key: 'x', cron: 'bad', enabled: true }, now), false, '坏 cron 只跳过，不抛');
});

// ── 2. 配额 ─────────────────────────────────────────────────────────────
check('QuotaBook：每分钟与每日上限都生效，超额给原因', () => {
  const file = path.join(os.tmpdir(), `qqb-quota-${process.pid}-${Date.now()}.json`);
  const q = new m.QuotaBook(file, { group: { perMinute: 2, perDay: 3 } });
  const t = new Date(2026, 9, 29, 9, 0);
  assert.equal(q.take('group', 'group:official-A', t).ok, true);
  assert.equal(q.take('group', 'group:official-A', t).ok, true);
  const third = q.take('group', 'group:official-A', t);
  assert.equal(third.ok, false);
  assert.match(third.reason, /本分钟/);
  // 下一分钟恢复
  assert.equal(q.take('group', 'group:official-A', new Date(2026, 9, 29, 9, 1)).ok, true);
  const fourth = q.take('group', 'group:official-A', new Date(2026, 9, 29, 9, 2));
  assert.equal(fourth.ok, false);
  assert.match(fourth.reason, /今日/);
  fs.rmSync(file, { force: true });
});

check('QuotaBook：单聊与群各自独立计数（不互相挤占）', () => {
  const file = path.join(os.tmpdir(), `qqb-quota2-${process.pid}-${Date.now()}.json`);
  const q = new m.QuotaBook(file, { group: { perMinute: 1, perDay: 9 }, private: { perMinute: 1, perDay: 9 } });
  const t = new Date(2026, 9, 29, 9, 0);
  assert.equal(q.take('group', 'group:official-A', t).ok, true);
  assert.equal(q.take('private', 'private:official-B', t).ok, true, '单聊不该被群的额度挡住');
  fs.rmSync(file, { force: true });
});

// ── 3. 错误翻译（权限 / 用户关闭 / 频控 三种要分开）─────────────────────
check('explainProactiveError：三类错误给三种人话', () => {
  assert.match(m.explainProactiveError('code 11000 no permission'), /群主.*主动推送/);
  assert.match(m.explainProactiveError('用户已关闭 not allowed'), /关闭.*允许主动发送/);
  assert.match(m.explainProactiveError('频率超限 2200'), /频控/);
  assert.equal(m.explainProactiveError('something else'), '');
});

// ── 3.5 互动召回窗口 ───────────────────────────────────────────────────
check('RecallWindow：30 天 4 个周期各 1 条，同周期重复被拒', () => {
  const file = path.join(os.tmpdir(), `qqb-recall-${process.pid}-${Date.now()}.json`);
  const w = new m.RecallWindow(file);
  const t0 = Date.now();
  assert.equal(w.claim('private:official-U1', t0).ok, true, '第一个周期');
  assert.equal(w.claim('private:official-U1', t0 + 3600_000).ok, false, '同周期不能再来一条');
  assert.equal(w.claim('private:official-U1', t0 + 2 * 86400_000).ok, true, '1-3 天周期');
  assert.equal(w.claim('private:official-U1', t0 + 4 * 86400_000).ok, true, '3-7 天周期');
  assert.equal(w.claim('private:official-U1', t0 + 10 * 86400_000).ok, true, '7-30 天周期');
  assert.equal(w.claim('private:official-U1', t0 + 11 * 86400_000).ok, false, '四个都用完了');
  const reopened = w.claim('private:official-U1', t0 + 31 * 86400_000);
  assert.equal(reopened.ok, true, '超过 30 天重新开窗');
  assert.equal(reopened.period, 0);
  fs.rmSync(file, { force: true });
});

check('接线：召回端点是单聊专用，且带 is_wakeup', () => {
  const api = read('src/api/official-say.js');
  assert.match(api, /official-recall/, '要有召回端点');
  assert.match(api, /private:/, '只允许单聊');
  assert.match(api, /wakeup: true/, '必须带 is_wakeup');
  const official = read('src/qqbot-official.js');
  assert.match(official, /is_wakeup/, 'SDK 层要能发 is_wakeup');
});

// ── 3.8 后续聊天意向 → 开召回 ──────────────────────────────────────────
check('detectRecallIntent：命中"希望陪伴/约定未来/主动邀约/告别再会"四类', () => {
  const cases = [
    ['希望以后都陪着我', '希望陪伴'],
    ['明天见', '约定未来'],
    ['我先睡了，明天聊', '告别+再会'],
    ['记得找我啊', '主动邀约'],
    ['晚安，明天说', '告别+再会']
  ];
  for (const [text, want] of cases) {
    const r = m.detectRecallIntent(text);
    assert.ok(r, `应命中：${text}`);
    assert.equal(r.reason, want, `${text} → ${want}`);
  }
});

check('tier：礼貌告别=soft（只开窗），有下文=firm（可召回）', () => {
  assert.equal(m.detectRecallIntent('晚安，明天见').tier, 'soft');
  assert.equal(m.detectRecallIntent('我先睡了，明天聊').tier, 'soft');
  assert.equal(m.detectRecallIntent('明天聊那个事').tier, 'firm', '有具体下文 → firm');
  assert.equal(m.detectRecallIntent('约好明天聊').tier, 'firm');
  assert.equal(m.detectRecallIntent('希望以后都陪着我').tier, 'firm');
});

check('detectRecallIntent：普通寒暄不能误判（否则等于给所有人开召回）', () => {
  for (const text of ['在吗', '哈哈哈哈', '晚安', '今天好热', '', null]) {
    assert.equal(m.detectRecallIntent(text), null, `不该命中：${text}`);
  }
  // 超长文本（引用转发/刷屏）不计，避免整段长文里偶现关键词就开窗
  assert.equal(m.detectRecallIntent('明天见'.repeat(100)), null);
});

check('RecallWindow.arm：开窗并记录原因，不改用已有配额', () => {
  const file = path.join(os.tmpdir(), `qqb-arm-${process.pid}-${Date.now()}.json`);
  const w = new m.RecallWindow(file);
  const t0 = Date.now();
  const r = w.arm('private:official-U9', { reason: '希望陪伴', now: t0 });
  assert.equal(r.ok, true);
  assert.equal(r.period, 0);
  assert.equal(w.armedInfo('private:official-U9').reason, '希望陪伴');
  assert.equal(w.claim('private:official-U9', t0).ok, true, 'arm 之后仍可正常 claim');
  fs.rmSync(file, { force: true });
});

check('接线：官方私聊入站时检测意向并 arm', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /detectRecallIntent\(event\.text\)/, '入站要识别意向');
  assert.match(bridge, /recallWindow\.arm\(/, '命中后要开窗');
  assert.match(bridge, /event\.kind === 'private'/, '只在单聊上做（召回是单聊能力）');
  assert.match(bridge, /armOnIntent/, '要有关闭开关');
});

// ── 4. 接线 ─────────────────────────────────────────────────────────────
check('接线：端点鉴权走 socialV2 前缀、sendText 支持 proactive、调度器可启动', () => {
  const api = read('src/api/official-say.js');
  assert.match(api, /\/api\/socialV2\/official-say/, '挂 socialV2 前缀才能继承 prelude 鉴权');
  assert.match(api, /proactive: true/, '必须强制主动（不带 msg_id）');
  assert.match(api, /proactiveQuota\.take/, '必须过配额');

  const transport = read('src/official-transport.js');
  assert.match(transport, /opts\.proactive/, 'sendText 要支持 proactive 开关');

  const bridge = read('src/bridge.js');
  assert.match(bridge, /handleOfficialSay/, '路由链要注册');
  assert.match(bridge, /ProactiveScheduler/, '调度器要实例化');
  assert.match(bridge, /sendOfficialProactive/, '要有统一出口');

  const cfg = JSON.parse(read('config.example.json'));
  assert.ok(cfg.official.proactive, '示例配置要有 proactive 段');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
