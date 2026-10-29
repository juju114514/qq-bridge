// pumpMux：DSH 事件流的分发（最容易出时序事故的一段，之前**零覆盖**）。
//
// 这个文件先给 pumpMux 建"护栏"，再谈搬它 —— 今晚三次翻车都发生在
// "没有端到端测试就搬核心逻辑"的地方。
//
// 覆盖点：
//   ① session/snapshot 只喂 token 账本，**绝不能**当成新回合去发 QQ 消息
//   ② 未知帧型不炸（pumpMux 继续跑）
//   ③ 喂帧后队列被消费（说明 pumpMux 真的在跑）

import assert from 'node:assert/strict';

const { bridgeHarness } = await import(new URL('../scripts/audit-bridge-harness.mjs', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await check('① 快照帧不产生 QQ 发送（只进 token 账本）', async () => {
  const h = await bridgeHarness();
  const run = h.pumpMux();                       // 不 await：它会一直跑
  h.pushMuxFrame({ type: 'session/snapshot', sessionId: 's-1', snapshot: { turns: [{ turn: 1 }] } });
  await wait(80);
  assert.equal(h.calls.sent.length, 0, '快照绝不能触发回复');
  h.stopMux();
  await Promise.race([run.catch(() => {}), wait(1200)]);
});

await check('② 未知帧型不炸（pumpMux 仍在跑）', async () => {
  const h = await bridgeHarness();
  const run = h.pumpMux();
  h.pushMuxFrame({ type: 'something/unknown', foo: 1 });
  h.pushMuxFrame({ type: 'session/event', sessionId: 's-1', event: { type: 'unknown-event' } });
  await wait(100);
  assert.equal(h.calls.sent.length, 0);
  h.stopMux();
  await Promise.race([run.catch(() => {}), wait(1200)]);
});

await check('③ 喂进去的帧会被消费（证明确实在跑）', async () => {
  const h = await bridgeHarness();
  const run = h.pumpMux();
  h.pushMuxFrame({ type: 'session/snapshot', sessionId: 's-1', snapshot: { turns: [] } });
  h.pushMuxFrame({ type: 'session/snapshot', sessionId: 's-2', snapshot: { turns: [] } });
  await wait(120);
  assert.equal(h.muxDrainCount(), 0, '两帧都该被消费掉');
  h.stopMux();
  await Promise.race([run.catch(() => {}), wait(1200)]);
});

console.log('');
if (failures === 0) console.log('  全部通过');
// pumpMux 的假 mux 生成器会一直 sleep（2ms），不主动退出的话测试进程会挂住。
// 这里显式退出：断言已经跑完，残留的 promise 没有意义。
process.exit(failures === 0 ? 0 : 1);