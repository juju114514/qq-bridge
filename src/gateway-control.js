// 网关（SnowLuma）状态与「用户手动启动」（0.4.131）
//
// 设计取向（跟用户确认过）：
//   · **不自动拉起**：只在用户点按钮时动手，桥接不当第三方程序的管理者
//   · **不由桥接 spawn**：改为触发 Windows 计划任务 qq-snowluma ——
//     这样网关不是桥接的子进程，桥接重启也不会把它带走
//   · 启动后不监控、不自动重启（崩了就崩了，下次点按钮）
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

export const TASK_NAME = 'qq-snowluma';
export const DEFAULT_PORTS = [3000, 3001, 5099];

/** 端口探活：能连上就算在听 */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ port: Number(port), host });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

function run(cmd, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// 防重复拉起（0.5.64）：
//   ① 同一进程内的并发/连点 —— 用一个 in-flight Promise 合流
//   ② 同一进程内的连续尝试 —— 冷却窗口（默认 5 分钟）
//   ③ 已经有 SnowLuma 进程在跑（可能正在启动）—— 只等端口，绝不再起第二份
// 现场事故：拉不起来时每 1~2 分钟起一套，堆到 13 套 / 27 个进程 / 上百 MB，窗口铺满屏幕。
const SPAWN_COOLDOWN_MS = Number(process.env.QQB_GATEWAY_SPAWN_COOLDOWN_MS) || 5 * 60 * 1000;
let spawnInflight = null;
let lastSpawnAt = 0;

/** 网关日志落点（0.4.134）：<dir>/logs/gateway.log */
export function gatewayLogPath(dir = snowlumaDir()) {
  return path.join(dir || '.', 'logs', 'gateway.log');
}

/** SnowLuma 安装目录：环境变量 > 常见位置 */
export function snowlumaDir(env = process.env) {
  const explicit = String(env.QQB_SNOWLUMA_DIR || '').trim();
  if (explicit && fs.existsSync(path.join(explicit, 'index.mjs'))) return explicit;
  // 不写死盘符：遍历所有盘符找 <盘>:\\QQBot\\snowluma（换机器也能找到）
  for (let i = 2; i < 26; i += 1) {              // C..Z
    const root = String.fromCharCode(65 + i) + ':';
    const cand = path.join(root, 'QQBot', 'snowluma');
    try { if (fs.existsSync(path.join(cand, 'index.mjs'))) return cand; } catch { /* 盘不存在 */ }
  }
  return '';
}

/**
 * 退路：直接拉起一个**脱离父进程**的网关进程。
 * 为什么 detached：这样桥接重启不会把它带走（子进程关系不成立）。
 */
export async function startViaSpawn(opts = {}) {
  // 单飞：并发调用共享同一个 Promise，绝不起两份
  if (spawnInflight) return spawnInflight;
  const running = startViaSpawnOnce(opts).finally(() => { spawnInflight = null; });
  spawnInflight = running;
  return running;
}

async function startViaSpawnOnce({
  dir = snowlumaDir(),
  timeoutMs = 12000,
  probe = probePort,
  ports = DEFAULT_PORTS,
  now = () => Date.now(),
  spawnImpl = spawn,
  listPidsImpl = null,
  cooldownMs = SPAWN_COOLDOWN_MS,
  waitExistingMs = 8000
} = {}) {
  const t0 = now();

  // ① 端口已在听 → 复用，绝不再起
  if ((await probe(3000)) || (await probe(3001))) {
    return { ok: true, started: false, reused: true, waited: 0, ports };
  }
  // ② 已经有 SnowLuma 进程（可能在启动中）→ 只等端口，绝不叠加第二份
  let existing = [];
  try { existing = await (listPidsImpl || listGatewayPids)({}); } catch { existing = []; }
  if (Array.isArray(existing) && existing.length) {
    const deadline = now() + Math.min(timeoutMs, waitExistingMs);
    while (now() < deadline) {
      if ((await probe(3000)) || (await probe(3001))) {
        return { ok: true, started: false, reused: true, waited: now() - t0, ports, existing: existing.length };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      ok: false, started: false, reused: false, existing: existing.length,
      error: `已有 ${existing.length} 个 SnowLuma 进程在跑但端口没起来（${existing.join(',')}），为防重复不再启动第二份`
    };
  }

  if (!dir) return { ok: false, started: false, error: '找不到 SnowLuma 目录（设 QQB_SNOWLUMA_DIR）' };
  const nodeExe = path.join(dir, 'node.exe');
  const entry = path.join(dir, 'index.mjs');
  if (!fs.existsSync(nodeExe)) return { ok: false, started: false, error: '缺少 node.exe：' + dir };
  if (!fs.existsSync(entry)) return { ok: false, started: false, error: '缺少 index.mjs：' + dir };

  // ③ 冷却窗口：本进程刚试过就等一会儿（现场堆到 13 套就是缺这一层）
  const tNow = now();
  if (cooldownMs > 0 && lastSpawnAt && tNow - lastSpawnAt < cooldownMs) {
    return {
      ok: false, started: false, throttled: true,
      error: `刚启动过（${Math.round((tNow - lastSpawnAt) / 1000)} 秒前），冷却 ${Math.round(cooldownMs / 1000)} 秒内不再重复拉起`
    };
  }

  // ④ 端口没通又没有进程 → 此时才是真的需要拉起（日志句柄不能是 ignore）
  const logFile = gatewayLogPath(dir);
  let outFd = null;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    outFd = fs.openSync(logFile, 'a');
  } catch { outFd = null; }

  lastSpawnAt = tNow;
  const child = spawnImpl(nodeExe, ['index.mjs'], {
    cwd: dir,
    detached: true,
    stdio: outFd === null ? 'ignore' : ['ignore', outFd, outFd],
    windowsHide: true
  });
  child.unref();
  if (outFd !== null) { try { fs.closeSync(outFd); } catch { /* ignore */ } }

  let waited = 0;
  while (waited < timeoutMs) {
    for (const pt of ports) {
      if (await probe(pt)) return { ok: true, started: true, waited: now() - t0, pid: child.pid, via: 'spawn', error: '' };
    }
    await new Promise((r) => setTimeout(r, 800));
    waited = now() - t0;
  }
  return {
    ok: false, started: true, waited: now() - t0, pid: child.pid, via: 'spawn',
    error: `已拉起（pid ${child.pid}），但 ${Math.round(timeoutMs / 1000)} 秒内端口没起来`
  };
}

/** 计划任务在不在（windows only） */
export async function taskExists(name = TASK_NAME) {
  if (process.platform !== 'win32') return false;
  const r = await run('schtasks', ['/query', '/tn', name]);
  return r.ok;
}

/**
 * 当前状态。
 * @param {{ports?:number[], task?:string, probe?:(p:number)=>Promise<boolean>}} [opts]
 */
export async function getGatewayStatus(opts = {}) {
  const ports = Array.isArray(opts.ports) && opts.ports.length ? opts.ports : DEFAULT_PORTS;
  const probe = opts.probe || probePort;
  const listening = {};
  for (const p of ports) listening[p] = await probe(p);

  const anyUp = Object.values(listening).some(Boolean);
  const hasTask = opts.taskExistsImpl ? await opts.taskExistsImpl() : await taskExists(opts.task);
  return {
    running: anyUp,
    listening,
    task: opts.task || TASK_NAME,
    taskExists: hasTask,
    // 给 UI 用的一句结论
    hint: anyUp
      ? '网关在运行'
      : (hasTask ? '网关未运行，可一键启动' : '网关未运行，且没有 qq-snowluma 计划任务（先跑 install-snowluma-task.ps1）')
  };
}

/**
 * 用户点击「启动网关」。
 * 只在网关确实没起来时才触发；启动后轮询端口，最多等 waitMs。
 * @returns {Promise<{ok:boolean, started:boolean, waited:number, status:object, error?:string}>}
 */
export async function startGateway(opts = {}) {
  const {
    ports = DEFAULT_PORTS,
    probe = probePort,
    waitMs = 15000,
    pollMs = 1000,
    runImpl = run,
    now = () => Date.now()
  } = opts;

  // 【0.5.63】防重复启动：只要 3000/3001 已经有人在听，就当作"已在跑"，直接复用。
  // 以前只靠 getGatewayStatus 的 running 判定，端口组合一变（比如 5099 没起）就会误判成"没跑"，
  // 于是每次重启桥接都再拉起一份 SnowLuma，窗口越堆越多（实测堆到 5 组）。
  const listening = (await probe(3000)) || (await probe(3001));
  if (listening) {
    const st = await getGatewayStatus({ ports, probe, task: opts.task, taskExistsImpl: opts.taskExistsImpl });
    return { ok: true, started: false, reused: true, waited: 0, status: st, error: '' };
  }

  const before = await getGatewayStatus({ ports, probe, task: opts.task, taskExistsImpl: opts.taskExistsImpl });
  if (before.running) {
    return { ok: true, started: false, waited: 0, status: before, error: '' };
  }
  if (!before.taskExists) {
    // 没有计划任务（创建任务需要管理员）→ 退到 detached spawn，仍然不是桥接的子进程生命周期
    const spawned = await startViaSpawn({ probe, ports, now });
    return { ...spawned, status: await getGatewayStatus({ ports, probe, taskExistsImpl: async () => false }), via: 'spawn' };
  }

  const t0 = now();
  const started = await runImpl('schtasks', ['/run', '/tn', before.task]);
  if (!started.ok) {
    return { ok: false, started: false, waited: 0, status: before, error: `schtasks /run 失败：${started.stderr.trim() || started.code}` };
  }

  // 轮询到 3000（或任意一个端口）通为止
  let waited = 0;
  while (waited < waitMs) {
    const st = await getGatewayStatus({ ports, probe, task: before.task, taskExistsImpl: async () => true });
    if (st.running) return { ok: true, started: true, waited: now() - t0, status: st, error: '' };
    await new Promise((r) => setTimeout(r, pollMs));
    waited = now() - t0;
  }
  const final = await getGatewayStatus({ ports, probe, task: before.task, taskExistsImpl: async () => true });
  return { ok: false, started: true, waited: now() - t0, status: final, error: `已触发计划任务，但 ${Math.round(waitMs / 1000)} 秒内端口没起来（看 D:\\QQBot\\snowluma\\logs）` };
}

/**
 * 网关"活着吗"（0.4.132）：端口通 + 桥接的 WS 状态，两条一起看。
 *
 * 为什么不像官方通道那样用"多久没数据"判死：网关在没人说话的夜里可以几小时没有事件，
 * 那是正常安静，不是假连接。所以判据是 **端口在听 + WS connected**，事件时间只作展示。
 *
 * @param {{probe?:Function, ports?:number[], bridgeState?:string, lastEventAt?:number, now?:()=>number}} opts
 */
export async function getGatewayHealth(opts = {}) {
  const {
    probe = probePort,
    ports = DEFAULT_PORTS,
    bridgeState = 'unknown',
    lastEventAt = 0,
    probeLogin = null,
    now = () => Date.now()
  } = opts;

  const listening = {};
  for (const p of ports) listening[p] = await probe(p);
  const anyPort = Object.values(listening).some(Boolean);
  const ageMs = lastEventAt ? now() - lastEventAt : null;

  const login = probeLogin ? await probeLogin() : { checked: false, online: null };
  const qqOnline = login && login.checked ? login.online : null;

  let level = 'ok';
  let text = '网关正常';
  if (!anyPort) { level = 'error'; text = '网关未运行（端口不通）'; }
  else if (bridgeState !== 'connected') { level = 'warn'; text = '网关在听，但桥接还没连上（重连中）'; }
  else if (qqOnline === false) { level = 'error'; text = '网关在跑，但 QQ 未登录（收不到任何消息）'; }

  return {
    level,
    text,
    liveness: {
      connected: bridgeState === 'connected',
      bridgeState,
      listening,
      portUp: anyPort,
      qqOnline,
      loginChecked: Boolean(login && login.checked),
      loginError: login?.error || '',
      lastEventAt: lastEventAt || null,
      ageMs
    }
  };
}

/** GET /api/gateway/health 的处理逻辑（纯函数便于测） */
export async function gatewayHealthPayload(deps = {}) {
  const state = typeof deps.getGatewayState === 'function' ? deps.getGatewayState() : 'unknown';
  let token = '';
  let httpUrl = 'http://127.0.0.1:3000';
  try {
    const cfg = typeof deps.getCfg === 'function' ? deps.getCfg() : null;
    token = String(cfg?.snowluma?.httpToken || cfg?.snowluma?.accessToken || '');
    if (cfg?.snowluma?.httpUrl) httpUrl = String(cfg.snowluma.httpUrl);
  } catch { /* 取不到就不带 token 试一次 */ }
  let lastEventAt = 0;
  try {
    const snap = typeof deps.getSelfCheck === 'function' ? deps.getSelfCheck() : null;
    lastEventAt = Number(snap?.snowluma?.lastEventAt || 0);
  } catch { lastEventAt = 0; }
  return getGatewayHealth({
    bridgeState: String(state || 'unknown'),
    lastEventAt,
    probeLogin: () => probeQqOnline({ url: httpUrl, token })
  });
}

/**
 * QQ 号在线吗（0.4.133）。
 *
 * 为什么需要：进程活着、WS 也连着，但**QQ 登录态掉了**（异地登录/被踢/二维码过期），
 * 这时收不到任何消息，而端口和 WS 全是绿的 —— 比"进程死了"更难发现。
 * 判据：OneBot `/get_status` 的 `data.online`。
 *
 * @param {{url?:string, token?:string, timeoutMs?:number, fetchImpl?:Function}} opts
 * @returns {Promise<{checked:boolean, online:boolean|null, error?:string}>}
 */
export async function probeQqOnline(opts = {}) {
  const { url = 'http://127.0.0.1:3000', token = '', timeoutMs = 2500, fetchImpl = fetch } = opts;
  try {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/get_status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { checked: false, online: null, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    const online = body?.data?.online;
    if (typeof online !== 'boolean') return { checked: false, online: null, error: '返回里没有 online 字段' };
    return { checked: true, online };
  } catch (error) {
    return { checked: false, online: null, error: String(error?.message ?? error).slice(0, 120) };
  }
}

/**
 * 列出 SnowLuma 相关进程（0.4.142）
 *
 * 为什么必须有：SnowLuma **不会**自我单例 —— 每点一次「启动网关」就多一套进程，
 * 而且旧的不退出（2026-11-02 实测堆到 8 套、16 个 node.exe、约 1 GB 内存）。
 * 这里用任务计划之外的独立查询：按命令行里的 snowluma + index.mjs 认，
 * 排除桥接自己的路径，避免把 MCP/桥接一起杀掉。
 *
 * @param {{execImpl?:Function, nodeExe?:string, snowlumaDir?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<number[]>}
 */
export async function listGatewayPids(opts = {}) {
  const { execImpl = execFile, nodeExe = process.execPath, timeoutMs = 8000 } = opts;
  // 两个条件都要试：有的实例 CommandLine 取不到（不同完整性级别），但 ExecutablePath 有值。
  // 只用 CommandLine 会漏掉它们 → 又堆起来。
  const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -EA SilentlyContinue | "
    + "Where-Object { ($_.CommandLine -like '*snowluma*index.mjs*') -or ($_.ExecutablePath -like '*\\snowluma\\*') } | "
    + "Select-Object -ExpandProperty ProcessId";
  return new Promise((resolve) => {
    try {
      execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err && !stdout) { resolve([]); return; }
        const pids = String(stdout || '').split(/\s+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid && n !== Number(nodeExe));
        resolve(pids);
      });
    } catch { resolve([]); }
  });
}

/**
 * 停掉所有 SnowLuma 进程（先礼后兵：先正常 kill，再强制）。
 * @returns {Promise<{stopped:number[], remaining:number[]}>}
 */
export async function stopGateway(opts = {}) {
  const { killImpl = (pid) => process.kill(pid), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), listImpl = listGatewayPids } = opts;
  const pids = await listImpl(opts);
  const stopped = [];
  for (const pid of pids) {
    try { killImpl(pid); stopped.push(pid); } catch { /* 已经没了 */ }
  }
  await sleep(1200);
  const remaining = (await listImpl(opts)).filter((p) => !stopped.includes(p));
  return { stopped, remaining };
}

/**
 * 完全重启网关（0.5.65）
 * 现实：SnowLuma 有 launcher，杀了子进程会自己拉回来，"进程清零"永远达不到。
 * 所以：多轮 stop → 等自愈（或没有 launcher 时 spawn）→ 报端口状态。
 */
export async function restartGateway(opts = {}) {
  const { ports = DEFAULT_PORTS, log = () => {}, waitUpMs = 45000 } = opts;
  const gwOpts = { ports };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const stoppedAll = [];
  for (let round = 1; round <= 3; round += 1) {
    const stop = await stopGateway(gwOpts);
    stoppedAll.push(...stop.stopped);
    log(`[gateway] 完全重启 第${round}轮：停 ${stop.stopped.length} 个，剩余 ${stop.remaining.length} 个`);
    if (!stop.remaining.length && round >= 2) break;
    await sleep(2000);
  }

  let back = false;
  for (let waited = 0; waited < waitUpMs; waited += 1000) {
    const procs = await listGatewayPids(gwOpts);
    const st = await getGatewayStatus(gwOpts);
    if (procs.length > 0 && Object.values(st.listening).some(Boolean)) { back = true; break; }
    await sleep(1000);
  }

  let spawned = null;
  if (!back) {
    const procs = await listGatewayPids(gwOpts);
    if (procs.length === 0) spawned = await startGateway({ ...gwOpts, waitMs: 30000 });
  }

  const st = await getGatewayStatus(gwOpts);
  const procs = await listGatewayPids(gwOpts);
  const onebotUp = !!(st.listening[3000] && st.listening[3001]);
  const ok = onebotUp || !!spawned?.ok || (back && Object.values(st.listening).some(Boolean));
  log(`[gateway] 完全重启完成：进程 ${procs.length}，端口 ${JSON.stringify(st.listening)}${onebotUp ? '' : '（OneBot 未就绪，可能需要在网关里加载 QQ 账号）'}`);
  return {
    ok,
    at: Date.now(),
    stopped: stoppedAll,
    processes: procs.length,
    ports: st.listening,
    onebotReady: onebotUp,
    spawned: !!spawned,
    hint: onebotUp ? '' : 'OneBot 端口还没起来：打开网关 WebUI 看是否需要「加载 QQ 账号」'
  };
}
