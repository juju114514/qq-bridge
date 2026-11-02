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
export async function startViaSpawn({ dir = snowlumaDir(), timeoutMs = 12000, probe = probePort, ports = DEFAULT_PORTS, now = () => Date.now(), spawnImpl = spawn } = {}) {
  if (!dir) return { ok: false, started: false, error: '找不到 SnowLuma 目录（设 QQB_SNOWLUMA_DIR）' };
  const nodeExe = path.join(dir, 'node.exe');
  const entry = path.join(dir, 'index.mjs');
  if (!fs.existsSync(nodeExe)) return { ok: false, started: false, error: '缺少 node.exe：' + dir };
  const t0 = now();
  const child = spawnImpl(nodeExe, ['index.mjs'], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  let waited = 0;
  while (waited < timeoutMs) {
    for (const p of ports) {
      if (await probe(p)) return { ok: true, started: true, waited: now() - t0, pid: child.pid, via: 'spawn', error: '' };
    }
    await new Promise((r) => setTimeout(r, 800));
    waited = now() - t0;
  }
  return { ok: false, started: true, waited: now() - t0, pid: child.pid, via: 'spawn', error: `已拉起（pid ${child.pid}），但 ${Math.round(timeoutMs / 1000)} 秒内端口没起来` };
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
