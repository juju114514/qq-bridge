// 长期记忆（src/memory-store.js）的契约测试：全离线。
//
// 这块最容易"看起来对、实际慢慢烂"：权重算错 → 什么都重要；衰减不生效 → 旧事压住新事；
// 合并阈值太低 → 两条不相干的事被并成一条（信息直接丢）。所以每个公式都要钉住。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const m = await import(new URL('../src/memory-store.js', import.meta.url).href);

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

// ── 1. 分词 ──────────────────────────────────────────────────────────────
check('tokenize：中文取二元组、英文取整词、数字保留', () => {
  const t = m.tokenize('小鲸鱼今天吃火锅了，OK 3次');
  assert.ok(t.has('小鲸'), '中文要有二元组');
  assert.ok(t.has('火锅'));
  assert.ok(t.has('ok'));
  assert.ok(t.has('3次') === false, '跨语言不拼二元组');
  assert.ok(m.tokenize('').size === 0);
  assert.ok(m.tokenize('鲸').has('鲸'), '单字也要保留');
});

// ── 2. 衰减 ──────────────────────────────────────────────────────────────
check('effectiveWeight：半衰期 30 天，30 天后剩一半，90 天后剩 1/8', () => {
  const atom = { weight: 2, createdAt: NOW };
  assert.ok(Math.abs(m.effectiveWeight(atom, NOW) - 2) < 1e-9);
  assert.ok(Math.abs(m.effectiveWeight(atom, NOW + 30 * DAY) - 1) < 1e-6);
  assert.ok(Math.abs(m.effectiveWeight(atom, NOW + 90 * DAY) - 0.25) < 1e-6);
  assert.equal(m.effectiveWeight(null), 0);
  assert.equal(m.effectiveWeight({ weight: 0, createdAt: NOW }, NOW), 0);
});

// ── 3. 强化 ──────────────────────────────────────────────────────────────
check('reinforce：每次 +0.3、命中次数累加、权重封顶 3', () => {
  const a = { weight: 1, hits: 0 };
  m.reinforce(a, NOW);
  assert.equal(a.hits, 1);
  assert.ok(Math.abs(a.weight - 1.3) < 1e-9);
  for (let i = 0; i < 20; i += 1) m.reinforce(a, NOW);
  assert.equal(a.weight, m.WEIGHT_CAP, '必须封顶，否则老话题会永久霸榜');
  assert.equal(a.lastHitAt, NOW);
});

// ── 4. 打分与排序 ────────────────────────────────────────────────────────
check('scoreAtom：关键词命中 > 不命中；旧条目分数更低', () => {
  const fresh = { text: '小鲸鱼喜欢火锅', weight: 1, createdAt: NOW, lastHitAt: NOW };
  const old = { text: '小鲸鱼喜欢火锅', weight: 1, createdAt: NOW - 180 * DAY, lastHitAt: NOW - 180 * DAY };
  const other = { text: '今天天气不错', weight: 1, createdAt: NOW, lastHitAt: NOW };
  const q = '火锅';
  const sf = m.scoreAtom(fresh, q, NOW).score;
  const so = m.scoreAtom(old, q, NOW).score;
  const su = m.scoreAtom(other, q, NOW).score;
  assert.ok(sf > su, `命中应高于未命中：${sf} vs ${su}`);
  assert.ok(sf > so, `新条目应高于旧条目：${sf} vs ${so}`);
});

check('rankAtoms：按分数排序 + 条数上限 + 字符预算（超预算跳过长的，不硬截断）', () => {
  const atoms = [
    { text: '约定：周五四点交作业', weight: 2, createdAt: NOW, lastHitAt: NOW },
    { text: '无关的一长串天气描述'.repeat(20), weight: 3, createdAt: NOW, lastHitAt: NOW },
    { text: 'A 怕被叫叔叔', weight: 1, createdAt: NOW, lastHitAt: NOW },
    { text: '', weight: 9 }
  ];
  const r = m.rankAtoms(atoms, { query: '作业 叔叔', now: NOW, limit: 2, maxChars: 100 });
  assert.ok(r.length <= 2);
  assert.ok(r.every((x) => x.atom.text.trim().length > 0), '空条目必须被过滤');
  const r2 = m.rankAtoms(atoms, { query: '作业 叔叔', now: NOW, limit: 6, maxChars: 60 });
  assert.ok(r2.every((x) => x.atom.text.length <= 60), '字符预算必须生效');
});

// ── 5. 合并 ──────────────────────────────────────────────────────────────
check('addAtom：相似内容合并加权，不同内容新增；空内容跳过', () => {
  const list = [];
  assert.equal(m.addAtom(list, { text: '周五四点交作业', now: NOW }).action, 'added');
  assert.equal(m.addAtom(list, { text: '周五四点交作业', now: NOW }).action, 'merged');
  assert.equal(m.addAtom(list, { text: '   ', now: NOW }).action, 'skipped');
  assert.equal(list.length, 1, '合并后不能多出一条');
  assert.equal(list[0].hits, 1, '合并要记命中');

  const r = m.addAtom(list, { text: '今天吃了牛肉面', now: NOW });
  assert.equal(r.action, 'added');
  assert.equal(list.length, 2);
});

check('addAtom：容量上限 200，超出按有效权重淘汰最弱（不是最旧）', () => {
  const list = [];
  for (let i = 0; i < 205; i += 1) {
    list.push({ text: `事实 ${i} 号`, weight: i === 0 ? 0.01 : 1, createdAt: NOW, lastHitAt: NOW });
  }
  m.addAtom(list, { text: '新的重要事实', now: NOW });
  assert.ok(list.length <= m.MAX_ATOMS, `实际 ${list.length}`);
  assert.ok(!list.some((a) => a.text === '事实 0 号'), '最弱的应被淘汰');
});

// ── 6. 归档 ──────────────────────────────────────────────────────────────
check('archiveAtoms：有效权重低于阈值进归档，其余保留', () => {
  const atoms = [
    { text: '很久以前的事', weight: 1, createdAt: NOW - 365 * DAY, lastHitAt: NOW - 365 * DAY },
    { text: '昨天的事', weight: 1, createdAt: NOW - 1 * DAY, lastHitAt: NOW }
  ];
  const { keep, archived } = m.archiveAtoms(atoms, { now: NOW });
  assert.equal(archived.length, 1);
  assert.equal(keep.length, 1);
  assert.equal(archived[0].text, '很久以前的事');
});

// ── 7. 迁移与注入 ────────────────────────────────────────────────────────
check('migrateFromLegacy：话题与群友印象转成原子，pendingThoughts 不迁移', () => {
  const atoms = m.migrateFromLegacy({
    activeTopics: [{ text: '周五交作业', lastMentionAt: NOW - DAY }],
    memberImpressions: { 小明: { traits: ['爱熬夜'], interactionCount: 7 } },
    pendingThoughts: [{ text: '想问他吃了没' }]
  }, NOW);
  assert.equal(atoms.length, 2);
  assert.ok(atoms.some((a) => a.text === '周五交作业' && a.createdAt === NOW - DAY));
  assert.ok(atoms.some((a) => a.text === '小明：爱熬夜' && a.hits === 7));
  assert.ok(!atoms.some((a) => a.text.includes('吃了没')), '临时想法不属于长期记忆');
});

check('formatLongTerm：空则返回空串；有则带标题与条目，长文本截断', () => {
  assert.equal(m.formatLongTerm([], { now: NOW }), '');
  const text = m.formatLongTerm([{ text: 'x'.repeat(300), weight: 3, createdAt: NOW, lastHitAt: NOW }], { now: NOW });
  assert.match(text, /【记得的事】/);
  assert.ok(text.split('\n')[1].length < 140, '单条要截断');
});

// ── 8. 接线 ──────────────────────────────────────────────────────────────
check('接线：写入端点镜像长期记忆，读取端点注入 top-K', () => {
  const write = read('src/api/socialV2-write.js');
  const rd = read('src/api/socialV2-read.js');
  assert.match(write, /longTermMemories/, '写入必须落长期层');
  assert.match(write, /addAtom|migrateFromLegacy/, '要用 memory-store 的写入逻辑');
  assert.match(rd, /longTermMemories/, '读取要读长期层');
  assert.match(rd, /formatLongTerm|rankAtoms/, '读取要打分排序');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
