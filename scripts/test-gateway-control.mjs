// 网关状态与手动启动（0.4.131）
import assert from 'node:assert/strict';

const m = await import(new URL('../src/gateway-control.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

await check('getGatewayStatus：全部端口不通 → running=false', async () => {
  const st = await m.getGatewayStatus({ probe: async () => false, taskExistsImpl: async () => true });
  assert.equal(st.running, false);
  assert.equal(st.taskExists, true);
  assert.match(st.hint, /可一键启动/);
});

await check('getGatewayStatus：任意端口通 → running=true', async () => {
  const st = await m.getGatewayStatus({ probe: async (p) => p === 3001, taskExistsImpl: async () => true });
  assert.equal(st.running, true);
  assert.equal(st.listening[3001], true);
  assert.match(st.hint, /在运行/);
});

await check('没有计划任务时 hint 提示先装任务', async () => {
  const st = await m.getGatewayStatus({ probe: async () => false, taskExistsImpl: async () => false });
  assert.match(st.hint, /install-snowluma-task/);
});

await check('startGateway：已经在跑 → 不重复启动', async () => {
  let spawned = 0;
  const r = await m.startGateway({
    probe: async () => true,
    taskExistsImpl: async () => true,
    runImpl: async () => { spawned += 1; return { ok: true }; }
  });
  assert.equal(r.ok, true);
  assert.equal(r.started, false);
  assert.equal(spawned, 0, '不该再触发 schtasks');
});

await check('startGateway：有任务 → schtasks /run 后轮询到端口通', async () => {
  let calls = 0;
  let port = false;
  const r = await m.startGateway({
    probe: async () => port,
    taskExistsImpl: async () => true,
    pollMs: 5,
    waitMs: 3000,
    runImpl: async (cmd, args) => { calls += 1; assert.equal(cmd, 'schtasks'); assert.deepEqual(args.slice(0, 2), ['/run', '/tn']); port = true; return { ok: true }; }
  });
  assert.equal(r.ok, true);
  assert.equal(r.started, true);
  assert.equal(calls, 1);
});

await check('startGateway：schtasks 失败 → ok=false 且带错误', async () => {
  const r = await m.startGateway({
    probe: async () => false,
    taskExistsImpl: async () => true,
    runImpl: async () => ({ ok: false, code: 1, stderr: 'Access is denied.', stdout: '' })
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Access is denied/);
});

await check('startGateway：没任务 → 走 detached spawn 而不是 schtasks', async () => {
  let spawnedDir = '';
  const r = await m.startGateway({
    probe: async () => false,
    taskExistsImpl: async () => false,
    pollMs: 5,
    waitMs: 200,
    runImpl: async () => { throw new Error('不该走 schtasks'); },
    spawnFallback: async ({ dir }) => { spawnedDir = dir; return { ok: false, started: true, error: 'port timeout' }; }
  });
  // 没传 spawnFallback 时用的是内部 startViaSpawn（会因找不到目录而失败）
  assert.equal(r.ok, false);
});


await check('getGatewayHealth：端口通 + 已连接 → ok', async () => {
  const h = await m.getGatewayHealth({ probe: async (p) => p === 3000, bridgeState: 'connected', lastEventAt: Date.now() - 5000 });
  assert.equal(h.level, 'ok');
  assert.match(h.text, /正常/);
  assert.equal(h.liveness.portUp, true);
  assert.equal(h.liveness.connected, true);
});

await check('getGatewayHealth：端口不通 → error（网关未运行）', async () => {
  const h = await m.getGatewayHealth({ probe: async () => false, bridgeState: 'disconnected' });
  assert.equal(h.level, 'error');
  assert.match(h.text, /未运行/);
});

await check('getGatewayHealth：端口在听但桥接没连上 → warn（重连中）', async () => {
  const h = await m.getGatewayHealth({ probe: async (p) => p === 3001, bridgeState: 'disconnected' });
  assert.equal(h.level, 'warn');
  assert.match(h.text, /重连/);
});

await check('gatewayHealthPayload：从 deps 读状态与最后事件时间', async () => {
  const p = await m.gatewayHealthPayload({
    getGatewayState: () => 'connected',
    getSelfCheck: () => ({ snowluma: { lastEventAt: 111 } }),
    probe: async () => true
  });
  assert.equal(p.liveness.bridgeState, 'connected');
  assert.equal(p.liveness.lastEventAt, 111);
});


await check('getGatewayHealth：端口通 + 已连接 + QQ 在线 → ok', async () => {
  const h = await m.getGatewayHealth({
    probe: async () => true, bridgeState: 'connected',
    probeLogin: async () => ({ checked: true, online: true })
  });
  assert.equal(h.level, 'ok');
  assert.equal(h.liveness.qqOnline, true);
});

await check('getGatewayHealth：进程活着但 QQ 未登录 → error（重点）', async () => {
  const h = await m.getGatewayHealth({
    probe: async () => true, bridgeState: 'connected',
    probeLogin: async () => ({ checked: true, online: false })
  });
  assert.equal(h.level, 'error');
  assert.match(h.text, /QQ 未登录/);
  assert.equal(h.liveness.qqOnline, false);
});

await check('getGatewayHealth：登录态查不到 → 不误报（仍是 ok）', async () => {
  const h = await m.getGatewayHealth({
    probe: async () => true, bridgeState: 'connected',
    probeLogin: async () => ({ checked: false, online: null, error: 'HTTP 401' })
  });
  assert.equal(h.level, 'ok');
  assert.equal(h.liveness.loginChecked, false);
  assert.match(h.liveness.loginError || '', /401/);
});

await check('probeQqOnline：正常响应解析 online', async () => {
  const r = await m.probeQqOnline({
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { online: false } }) })
  });
  assert.equal(r.checked, true);
  assert.equal(r.online, false);
});

await check('probeQqOnline：HTTP 失败不抛，标 checked=false', async () => {
  const r = await m.probeQqOnline({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(r.checked, false);
  assert.match(r.error, /500/);
});

await check('probeQqOnline：抛异常（端口关着）也返回结构化结果', async () => {
  const r = await m.probeQqOnline({ fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.equal(r.checked, false);
  assert.match(r.error, /ECONNREFUSED/);
});


await check('gatewayLogPath：落在 <dir>/logs/gateway.log', async () => {
  const pathMod = await import('node:path');
  assert.equal(m.gatewayLogPath(pathMod.join('x', 'snowluma')), pathMod.join('x', 'snowluma', 'logs', 'gateway.log'));
});

await check('startViaSpawn：spawn 时 stdout/stderr 指向日志文件，不是 ignore', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs');
  const nodePath = await import('node:path');
  const dir = fsp.mkdtempSync(nodePath.join(os.tmpdir(), 'qqb-gw-'));
  fsp.writeFileSync(nodePath.join(dir, 'node.exe'), '');
  fsp.writeFileSync(nodePath.join(dir, 'index.mjs'), '');
  let seen = null;
  const r = await m.startViaSpawn({
    dir,
    probe: async () => true,
    spawnImpl: (exe, args, opts) => { seen = opts; return { pid: 1234, unref() {} }; }
  });
  fsp.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.ok, true);
  assert.ok(seen, '没调到 spawn');
  assert.notEqual(seen.stdio, 'ignore', 'stdio 不能再是 ignore（会让 SnowLuma 起来后自杀）');
  assert.ok(Array.isArray(seen.stdio), 'stdio 应该是数组');
  assert.equal(seen.detached, true, '必须 detached（不随桥接退出）');
  assert.equal(seen.windowsHide, true);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }

// 0.5.63：端口已在听时，startGateway 必须复用而不是再拉一份
await check('startGateway：3000/3001 已在听 → 复用，不启动', async () => {
  let started = 0;
  const probe = async (port) => (port === 3000 || port === 3001);
  const r = await m.startGateway({
    probe,
    runImpl: async () => { started += 1; return { ok: true }; },
    taskExistsImpl: async () => true
  });
  assert.equal(r.started, false);
  assert.equal(r.reused, true);
  assert.equal(started, 0);
});
