// /提醒 命令（src/scheduler/commands.js + src/incoming-status-commands.js）
//
// 为什么不靠 QQ 真机测：网关（SnowLuma）可能不在线，而这条链路是**纯逻辑**，
// 用假的 sendToQQ 就能完整验证：解析 → 建任务 → 列表 → 删。
// 关键是**共用同一个调度器单例**（控制台建的任务，命令里要能看到）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { parseRemindCommand, REMIND_HELP } = await import(new URL('../src/scheduler/commands.js', import.meta.url).href);
const { getSchedulerInstance, resetSchedulerInstance } = await import(new URL('../src/scheduler/instance.js', import.meta.url).href);
const { createIncomingStatusCommands } = await import(new URL('../src/incoming-status-commands.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-'));
const cfg = { ownerQQ: '10001', allow: { groups: ['456789'], private: [] } };

function makeHandler() {
  const sent = [];
  const sched = getSchedulerInstance({
    stateDir: tmp,
    getCfg: () => cfg,
    allowed: (kind, id) => kind === 'group' && cfg.allow.groups.includes(String(id)),
    deliverPrompt: async (key, text) => { sent.push({ key, text }); },
    log: () => {}
  });
  const h = createIncomingStatusCommands({
    sendToQQ: async (key, text) => { sent.push({ key, text }); },
    readRoleState: () => ({ role: '', mode: '' }),
    writeRoleStateForKey: () => {},
    sanitizeRoleName: (x) => x,
    resolveRoleName: () => '',
    listRoles: () => [],
    roleName: (x) => x,
    allowed: () => true,
    getCfg: () => cfg,
    getState: () => ({ sessions: {} }),
    getRoleState: () => ({ role: '', mode: '' }),
    getSelfCheck: () => ({}),
    buildSelfCheckReport: () => '',
    getDecisionTrace: () => null,
    schedulerDeps: () => ({
      stateDir: tmp,
      getCfg: () => cfg,
      allowed: (kind, id) => kind === 'group' && cfg.allow.groups.includes(String(id)),
      deliverPrompt: async (key, text) => { sent.push({ key, text }); },
      log: () => {}
    })
  });
  return { h, sent, sched };
}

resetSchedulerInstance();

await check('/提醒 不带参数 → 帮助', async () => {
  const { h, sent } = makeHandler();
  assert.equal(await h.handleStatusCommands({ key: 'private:10001', kind: 'private', id: '10001', plainContent: '/提醒' }), true);
  assert.match(sent.at(-1).text, /定时任务（只有你能用/);
});

await check('/提醒 add daily → 建任务，且默认只发给管理员私聊', async () => {
  const { h, sent } = makeHandler();
  await h.handleStatusCommands({ key: 'private:10001', kind: 'private', id: '10001', plainContent: '/提醒 add daily 09:00 早上好' });
  const reply = sent.at(-1).text;
  assert.match(reply, /已建任务 #/);
  assert.match(reply, /只发给你自己/);
  const db = JSON.parse(fs.readFileSync(path.join(tmp, 'scheduler.json'), 'utf8'));
  assert.equal(db.tasks.length, 1);
  assert.deepEqual(db.tasks[0].targets, ['private:10001'], '必须只发管理员私聊');
});

await check('/提醒 list → 能看到刚建的任务（说明共用了同一个单例）', async () => {
  const { h, sent } = makeHandler();
  await h.handleStatusCommands({ key: 'private:10001', kind: 'private', id: '10001', plainContent: '/提醒 list' });
  assert.match(sent.at(-1).text, /定时任务：/);
  assert.match(sent.at(-1).text, /早上好/);
});

await check('/提醒 del 1 → 删掉', async () => {
  const { h, sent } = makeHandler();
  await h.handleStatusCommands({ key: 'private:10001', kind: 'private', id: '10001', plainContent: '/提醒 del 1' });
  assert.match(sent.at(-1).text, /已删除任务 #1/);
});

await check('解析错误要给可操作的提示（不是静默失败）', async () => {
  // 注意：命令层只校验"形状"（HH:mm），25:99 这种「形状对、值非法」由引擎在登记时拒绝 ——
  // 所以这里分两层验：形状错 → 解析期报错；值非法 → 登记期报错。
  const shapeBad = parseRemindCommand('/提醒 add daily 9点 早上好');
  assert.ok(shapeBad.error, '形状不对要报错');
  const noContent = parseRemindCommand('/提醒 add daily 09:00');
  assert.match(String(noContent.error), /内容/);

  const { h, sent } = makeHandler();
  await h.handleStatusCommands({ key: 'private:10001', kind: 'private', id: '10001', plainContent: '/提醒 add daily 25:99 早上好' });
  assert.match(String(sent.at(-1).text), /定时任务出错|时间/, `值非法时也要有可读提示，实际：${sent.at(-1).text}`);
});

await check('内容前加 ai → kind=ai（叫 AI 来说）', async () => {
  const r = parseRemindCommand('/提醒 add daily 09:00 ai 随便聊一句');
  assert.equal(r.action, 'add');
  assert.equal(r.task.kind, 'ai');
  assert.match(r.task.instruction, /随便聊一句/);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }