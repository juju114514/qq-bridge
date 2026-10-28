// 表情策展（src/sticker-curator.js）的契约测试：全离线。
//
// 要点：① 看不懂就不收藏 ② 重复不收藏 ③ 配额与冷却必须生效
// ④ 主动发表情不能变成刷屏 ⑤ 给模型的指令片段随开关变化

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const m = await import(new URL('../src/sticker-curator.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('normalizeMeaning：去引号、压空格、超长截断', () => {
  assert.equal(m.normalizeMeaning('「无语」'), '无语');
  assert.equal(m.normalizeMeaning('  笑死   我  '), '笑死 我');
  assert.equal(m.normalizeMeaning(''), '');
  assert.equal(m.normalizeMeaning('x'.repeat(50)).length, 24);
});

check('scoreSticker：看不懂=0，重复=0，有情绪词更高', () => {
  assert.equal(m.scoreSticker({ meaning: '' }), 0);
  assert.equal(m.scoreSticker({ meaning: '无语', duplicate: true }), 0);
  const plain = m.scoreSticker({ meaning: '一只猫' });
  const moody = m.scoreSticker({ meaning: '无语到翻白眼' });
  assert.ok(moody > plain, `情绪词应加分：${moody} vs ${plain}`);
  assert.ok(m.scoreSticker({ meaning: '无语', eyesOnly: true }) < m.scoreSticker({ meaning: '无语' }));
});

check('decideCollect：关闭开关 / 低分 / 配额都用不同 reason 拒绝', () => {
  assert.equal(m.decideCollect({ score: 0.9 }, { enabled: false }).reason, 'disabled');
  assert.equal(m.decideCollect({ score: 0.9 }, { enabled: true, autoCollect: false }).reason, 'disabled');
  assert.equal(m.decideCollect({ score: 0.2 }, { enabled: true }).reason, 'low-value');
  assert.equal(m.decideCollect({ score: 0.9, collectedToday: 20 }, { enabled: true, maxCollectPerDay: 20 }).reason, 'daily-quota');
  assert.equal(m.decideCollect({ score: 0.9, collectedToday: 0 }, { enabled: true }).collect, true);
});

check('decideProactiveSend：相关度不足 / 配额 / 冷却都拦住', () => {
  const now = 1_000_000_000;
  assert.equal(m.decideProactiveSend({ relevance: 0.3, now }, { enabled: true }).reason, 'not-relevant');
  assert.equal(m.decideProactiveSend({ relevance: 0.9, sentThisHour: 6, now }, { enabled: true }).reason, 'hourly-quota');
  assert.equal(m.decideProactiveSend({ relevance: 0.9, lastSentAt: now - 1000, now }, { enabled: true }).reason, 'cooldown');
  assert.equal(m.decideProactiveSend({ relevance: 0.9, lastSentAt: now - 9 * 60 * 1000, now }, { enabled: true }).send, true);
});

check('buildCuratorPrompt：关闭时为空，开关关闭时对应指令消失', () => {
  assert.equal(m.buildCuratorPrompt({ enabled: false }), '');
  const full = m.buildCuratorPrompt({ enabled: true });
  assert.match(full, /不收藏/);
  assert.match(full, /不必等被 @/);
  const noSend = m.buildCuratorPrompt({ enabled: true, proactiveSend: false });
  assert.ok(!/不必等被 @/.test(noSend), '关掉主动发送后不该再鼓励它主动发');
});

check('接线：配置示例里有 curator 段，且默认关闭（不乱刷）', () => {
  const cfg = JSON.parse(read('config.example.json'));
  const cur = cfg.socialV2?.sticker?.curator;
  assert.ok(cur, 'config.example.json 需要 socialV2.sticker.curator');
  assert.equal(cur.enabled, false, '默认关闭：别人装完不会突然开始刷表情');
  assert.equal(typeof cur.minMeaningScore, 'number');
  assert.equal(typeof cur.maxSendPerHour, 'number');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
