// 定时任务（src/scheduler/* + src/api/scheduler-routes.js）
//
// 引擎来自同源分叉 hdace-dsh-qq。这里钉住**接进来最容易接错的三处契约**：
//   1. validateTarget 返回错误字符串（不是布尔）—— 接错会导致所有任务登记失败
//   2. deliver(task, target, meta) —— 参数是任务对象，不是 (key, payload)
//   3. 目标必须在白名单内（定时任务不能给陌生人发消息）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createSchedulerRoutes } = await import(new URL('../src/api/scheduler-routes.js', import.meta.url).href);
const { resetSchedulerInstance } = await import(new URL('../src/scheduler/instance.js', import.meta.url).href);
const sched = await import(new URL('../src/scheduler/schedule.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
const cfg = { ownerQQ: '10001', allow: { groups: ['456789'], private: ['10002'] } };
const sent = [];

function makeRoutes() {
  // 引擎是**单例**：每个用例都要先重置，否则会复用上一个用例的依赖与数据
  resetSchedulerInstance();
  return createSchedulerRoutes({
    log: () => {},
    stateDir: tmp,
    getCfg: () => cfg,
    allowed: (kind, id) => (kind === 'group' ? cfg.allow.groups.includes(String(id)) : cfg.allow.private.includes(String(id))),
    deliverPrompt: async (key, text) => { sent.push({ key, text }); },
    onebotSend: async (kind, id, text) => { sent.push({ key: `${kind}:${id}`, text }); },
    readBody: async () => ({}),
    sendJson: () => {}
  });
}

await check('validateTarget：白名单内通过，白名单外给理由是字符串', () => {
  const r = makeRoutes();
  assert.equal(r.validateTarget('private:10001'), '', '管理员私聊永远可发');
  assert.equal(r.validateTarget('group:456789'), '');
  assert.equal(r.validateTarget('group:999999'), '目标不在白名单内（定时任务不给陌生人发消息）');
  assert.match(r.validateTarget('xxx'), /格式应为/);
});

await check('schedule：支持的规则能解析并算出下一次', () => {
  const s = sched.normalizeSchedule({ type: 'daily', times: ['09:00'] });
  const now = new Date('2026-10-30T00:00:00+08:00').getTime();
  const next = sched.nextOccurrence(s, now, { tz: 'Asia/Shanghai' });
  assert.ok(next, '应算出下一次');
  assert.ok(next > now);
});

await check('createTask：登记后出现在 snapshot 里，且能 runNow 真投递', async () => {
  const r = makeRoutes();
  const s = r.getScheduler();
  const task = s.createTask({
    name: '早报', kind: 'text', text: '早上好', targets: ['private:10001'],
    schedule: { type: 'daily', times: ['09:00'] }
  }, { source: 'console' });
  assert.ok(task.id >= 1);
  assert.equal(s.snapshot().tasks.length, 1);

  const run = await s.runNow(task.id, { source: 'console' });
  assert.ok(run);
  assert.equal(sent.length, 1, '应当真的投递一次');
  assert.equal(sent[0].key, 'private:10001');
  assert.match(sent[0].text, /早上好/);
});

await check('createTask：非白名单目标被拒绝（不是静默失败）', async () => {
  const r = makeRoutes();
  const s = r.getScheduler();
  assert.throws(() => s.createTask({
    name: 'x', kind: 'text', text: 'x', targets: ['group:999999'],
    schedule: { type: 'daily', times: ['09:00'] }
  }, { source: 'console' }), /白名单/);
});

await check('落盘：任务写进 state/scheduler.json（重启后还在）', async () => {
  const file = path.join(tmp, 'scheduler.json');
  assert.ok(fs.existsSync(file), '应该有落盘文件');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(raw.tasks) && raw.tasks.length >= 1);
});

const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sched2-'));

await check('deliver 契约：必须返回 { status: sent }，否则引擎记成 failed（消息发了也显示失败）', async () => {
  const sent2 = [];
  resetSchedulerInstance();
  const r2 = createSchedulerRoutes({
    log: () => {}, stateDir: tmp2, getCfg: () => cfg,
    allowed: () => true,
    onebotSend: async (kind, id, text) => { sent2.push({ kind, id, text }); },
    deliverPrompt: async () => {},
    readBody: async () => ({}), sendJson: () => {}
  });
  const s2 = r2.getScheduler();
  const task = s2.createTask({ name: 't', kind: 'text', text: 'hi', targets: ['private:10001'], schedule: { type: 'daily', times: ['09:00'] } }, { source: 'console' });
  const run = await s2.runNow(task.id, { source: 'console' });
  const outcome = (run?.outcomes || [])[0] || {};
  assert.equal(outcome.status, 'sent', `应为 sent，实际 ${JSON.stringify(outcome)}`);
  assert.equal(sent2.length, 1, '应该真的调了一次发送');
});

fs.rmSync(tmp2, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }