// 交接包（P2）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import(new URL('../src/agent/handoff.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

function stateDirWith(conv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-handoff-'));
  fs.writeFileSync(path.join(dir, 'social-v2.json'), JSON.stringify({ conversations: { 'private:1': conv } }));
  return dir;
}

await check('正常情况：拼出最近消息 + 话题 + 想说没说的', () => {
  const dir = stateDirWith({
    recentMessages: [
      { sender: '甲', text: '在吗', at: 1000 },
      { sender: '我', text: '在', at: 2000 }
    ],
    activeTopics: [{ text: '周末去哪' }],
    pendingThoughts: [{ text: '想问他要不要一起' }]
  });
  const brief = mod.buildHandoffBrief({ stateDir: dir, key: 'private:1', from: '手机本地', to: 'PC 的 DSH', now: 2000 });
  assert.match(brief, /【交接】/);
  assert.match(brief, /在吗/);
  assert.match(brief, /周末去哪/);
  assert.match(brief, /想问他要不要一起/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('没有任何可交接内容 → 返回空串（不塞"暂无"）', () => {
  const dir = stateDirWith({ recentMessages: [] });
  assert.equal(mod.buildHandoffBrief({ stateDir: dir, key: 'private:1', from: 'a', to: 'b' }), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('会话不存在 → 空串，不崩', () => {
  const dir = stateDirWith({});
  assert.equal(mod.buildHandoffBrief({ stateDir: dir, key: 'group:404', from: 'a', to: 'b' }), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('状态文件坏掉 → 空串，不崩', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-handoff-'));
  fs.writeFileSync(path.join(dir, 'social-v2.json'), '{坏');
  assert.equal(mod.buildHandoffBrief({ stateDir: dir, key: 'private:1', from: 'a', to: 'b' }), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('超长会截断（1200 字上限，别把上下文吃光）', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ sender: '甲', text: 'x'.repeat(90), at: i }));
  const dir = stateDirWith({ recentMessages: many });
  const brief = mod.buildHandoffBrief({ stateDir: dir, key: 'private:1', from: 'a', to: 'b' });
  assert.ok(brief.length <= 1201, `长度 ${brief.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('lastBrain 记在独立文件里（不污染会话状态）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-handoff-'));
  mod.writeHandoff(dir, { lastBrain: 'dsh', pending: {} });
  assert.equal(mod.readHandoff(dir).lastBrain, 'dsh');
  assert.ok(fs.existsSync(path.join(dir, 'brain-handoff.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('文件不存在时 readHandoff 返回空结构', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-handoff-'));
  const h = mod.readHandoff(dir);
  assert.equal(h.lastBrain, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
