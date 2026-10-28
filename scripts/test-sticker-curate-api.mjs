// 表情策展端点（src/api/sticker-curate.js）的契约测试：全离线、注入依赖。
//
// 钉住的行为：
//   ① 不带 apply 时零副作用（不收藏、不发送）
//   ② meaning 为空直接 400（说不出含义就别收藏）
//   ③ apply=true 且判定为收藏时才调用 collectSticker
//   ④ 判定为发送时才去挑候选表情

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const m = await import(pathToFileURL('D:/QQBot-open/qq-bridge/src/api/sticker-curate.js').href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const make = (body, cfg = { socialV2: { sticker: { curator: { enabled: true } } } }) => {
  const calls = { json: [], collected: [], picked: [] };
  const deps = {
    sendJson: (obj, status = 200) => calls.json.push({ obj, status }),
    readBody: async () => body,
    log: () => {},
    getCfg: () => cfg,
    collectSticker: async (key, meaning) => { calls.collected.push({ key, meaning }); },
    pickSticker: async (meaning, mood) => { calls.picked.push({ meaning, mood }); return { id: 'st1' }; }
  };
  return { handler: m.createStickerCurateHandler(deps), calls };
};

const req = { method: 'POST' };

await check('不带 apply：只返回决策，不产生副作用', async () => {
  const { handler, calls } = make({ key: 'group:1', meaning: '无语到翻白眼' });
  const claimed = await handler(req, { pathname: '/api/socialV2/sticker/curate' });
  assert.equal(claimed, true);
  assert.equal(calls.json[0].obj.applied, false);
  assert.equal(calls.json[0].obj.collect.collect, true);
  assert.equal(calls.collected.length, 0, '不该真收藏');
  assert.equal(calls.picked.length, 0, '不该真挑表情');
});

await check('meaning 为空 → 400（说不出含义就不收藏）', async () => {
  const { handler, calls } = make({ key: 'group:1', meaning: '' });
  await handler(req, { pathname: '/api/socialV2/sticker/curate' });
  assert.equal(calls.json[0].status, 400);
  assert.match(calls.json[0].obj.error, /含义/);
});

await check('apply=true 且判定收藏 → 调 collectSticker 一次', async () => {
  const { handler, calls } = make({ key: 'group:1', meaning: '无语到翻白眼', apply: true });
  await handler(req, { pathname: '/api/socialV2/sticker/curate' });
  assert.equal(calls.collected.length, 1);
  assert.equal(calls.json[0].obj.collected, true);
});

await check('低价值（重复）即便 apply=true 也不收藏', async () => {
  const { handler, calls } = make({ key: 'group:1', meaning: '无语', duplicate: true, apply: true });
  await handler(req, { pathname: '/api/socialV2/sticker/curate' });
  assert.equal(calls.collected.length, 0);
  assert.equal(calls.json[0].obj.collected, false);
});

await check('相关度够才挑候选表情', async () => {
  const low = make({ key: 'group:1', meaning: '无语', relevance: 0.2, apply: true });
  await low.handler(req, { pathname: '/api/socialV2/sticker/curate' });
  assert.equal(low.calls.picked.length, 0);

  const high = make({ key: 'group:1', meaning: '无语', relevance: 0.9, mood: '无语', apply: true });
  await high.handler(req, { pathname: '/api/socialV2/sticker/curate' });
  assert.equal(high.calls.picked.length, 1);
  assert.ok(high.calls.json[0].obj.candidate, '应带回候选表情');
});

await check('非本路径 / 非 POST 都正确返回', async () => {
  const { handler } = make({});
  assert.equal(await handler(req, { pathname: '/api/other' }), false);
  const { handler: h2, calls } = make({});
  await h2({ method: 'GET' }, { pathname: '/api/socialV2/sticker/curate' });
  assert.equal(calls.json[0].status, 405);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
