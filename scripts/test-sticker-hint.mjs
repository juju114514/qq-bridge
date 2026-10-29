// 表情 hint 与 curate 客户端：边界与 fail-open 的契约测试（离线）。

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const hint = await import(new URL('../src/sticker-hint.js', import.meta.url).href);
const client = await import(new URL('../src/sticker-curate-client.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

await check('hint：没传 scope 一律空串（跨会话不串的硬闸）', () => {
  const kept = [{ meaning: '无语', status: 'kept', scope: 'group' }];
  assert.equal(hint.buildBoundedStickerHint(kept), '', '缺 scope 必须为空');
  assert.equal(hint.buildBoundedStickerHint(kept, 'weird'), '', '非法 scope 也必须为空');
});

await check('hint：没有 kept 就返回空串（不加任何东西）', () => {
  assert.equal(hint.buildBoundedStickerHint([], 'group'), '');
  assert.equal(hint.buildBoundedStickerHint([{ meaning: '无语', status: 'pending', scope: 'group' }], 'group'), '');
  assert.equal(hint.buildBoundedStickerHint(null, 'group'), '');
});

await check('hint：群聊笔记绝不进私聊，私聊绝不进群聊', () => {
  const notes = [
    { meaning: '群聊表情', status: 'kept', scope: 'group', uses: 3 },
    { meaning: '私聊表情', status: 'kept', scope: 'private', uses: 9 }
  ];
  const g = hint.buildBoundedStickerHint(notes, 'group');
  const p = hint.buildBoundedStickerHint(notes, 'private');
  assert.match(g, /群聊表情/);
  assert.ok(!/私聊表情/.test(g), '群聊里不该出现私聊的表情');
  assert.match(p, /私聊表情/);
  assert.ok(!/群聊表情/.test(p), '私聊里不该出现群聊的表情');
});

await check('hint：最多 3 条、总长 ≤ 60 字，且带固定前缀', () => {
  const notes = Array.from({ length: 8 }, (_, i) => ({ meaning: `表情${i}号`, uses: i, status: 'kept', scope: 'group' }));
  const s = hint.buildBoundedStickerHint(notes, 'group');
  assert.ok(s.startsWith(hint.HINT_PREFIX), '必须有固定前缀');
  assert.ok(s.length <= hint.HINT_PREFIX.length + hint.HINT_MAX_CHARS, `超长：${s.length}`);
  assert.equal(s.split(' / ').length, 3, '最多 3 条');
});

await check('hint：按 uses 排序，用得多的在前', () => {
  const s = hint.buildBoundedStickerHint([
    { meaning: '少用', uses: 1, status: 'kept', scope: 'group' },
    { meaning: '常用', uses: 9, status: 'kept', scope: 'group' }
  ], 'group');
  assert.ok(s.indexOf('常用') < s.indexOf('少用'));
});

await check('client：没 token / 没含义时直接失败，不发请求', async () => {
  let called = 0;
  const fakeFetch = async () => { called += 1; return { ok: true, json: async () => ({}) }; };
  assert.equal((await client.askCurate({ meaning: '无语' }, { fetchImpl: fakeFetch })).error, 'no-token');
  assert.equal((await client.askCurate({ meaning: '' }, { token: 't', fetchImpl: fakeFetch })).error, 'no-meaning');
  assert.equal(called, 0, '不该发出请求');
});

await check('client：HTTP 非 2xx → ok=false 且带状态码（fail-open）', async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'disabled' }) });
  const r = await client.askCurate({ meaning: '无语' }, { token: 't', fetchImpl: fakeFetch });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

await check('client：抛异常 → ok=false，不向上抛（聊天不受影响）', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  const r = await client.askCurate({ meaning: '无语' }, { token: 't', fetchImpl: boom });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /ECONNREFUSED/);
});

await check('client：成功时把决策带回来', async () => {
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, score: 0.8, noteId: 'n1' }) });
  const r = await client.askCurate({ meaning: '无语' }, { token: 't', fetchImpl: okFetch });
  assert.equal(r.ok, true);
  assert.equal(r.decision.noteId, 'n1');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
