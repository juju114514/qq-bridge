// DSH 端口自动发现。
//
// 为什么必须有这个：**DSH 每次启动都会换一个随机回环端口**（实测 54694 → 65452 → 50075）。
// 以前只能让用户"把新端口写进 config.json 再重启桥接"，于是每次 DSH 重启，
// QQ 侧的表现都是「⏳ 系统服务重启中，消息已排队」——用户根本不知道该改哪里。
//
// 本模块的做法和 install.ps1 一致（复用同一套判据，避免两处口径漂移）：
//   1) 找进程名匹配 `DeepSeek|dsh` 的进程
//   2) 问系统这些 pid 在监听哪些端口（Get-NetTCPConnection）
//   3) 逐个用 HTTP 探活（**任何**响应都算活，包括 401 —— DSH 未鉴权就是 401）
// 非 Windows 平台没有 Get-NetTCPConnection，直接返回空并说明原因（不猜）。

import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

const CACHE_MS = 20000;
const cache = new Map(); // key(baseUrl|'') → { at, result }

/**
 * 环境变量 DSH_WEB_URL（由 DSH 注入给子进程）：最准的候选，不用扫描。
 * 只接受 http(s) 的本地回环地址，避免把外部地址当成本机 DSH。
 */
export function dshUrlFromEnv(env = process.env) {
  const raw = String(env?.DSH_WEB_URL ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const host = u.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') return '';
    return `${u.protocol}//${u.host}`;
  } catch { return ''; }
}

/** 平台闸门：只有 Windows 能问系统"这些 pid 在听哪些端口"。 */
export function canDiscoverPorts() {
  return process.platform === 'win32';
}

/**
 * 列出 DSH 相关进程正在监听的端口（Windows；其它平台返回空数组）。
 * @returns {Promise<number[]>}
 */
export async function listDshListeningPorts({ timeoutMs = 8000 } = {}) {
  if (!canDiscoverPorts()) return [];
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$p = @(Get-Process | Where-Object { $_.ProcessName -match "DeepSeek|dsh" } | ForEach-Object { $_.Id })',
    'if ($p.Count -eq 0) { "[]"; exit 0 }',
    '$ports = @(Get-NetTCPConnection -State Listen | Where-Object { $p -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort -Unique)',
    'if ($ports.Count -eq 0) { "[]" } else { ConvertTo-Json -Compress -InputObject $ports }'
  ].join('; ');
  const out = await new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve(''); return; }
    let buf = '';
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { } settle(''); }, timeoutMs);
    child.stdout.on('data', (chunk) => { buf += chunk.toString('utf8'); });
    child.on('error', () => settle(''));
    child.on('close', () => settle(buf));
  });
  const text = String(out ?? '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  } catch {
    return [];
  }
}

/** 端口上有没有 HTTP 服务（任何状态码都算活）。 */
export function probeHttpPort(port, { timeoutMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.setTimeout(timeoutMs);
      socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    let got = '';
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; try { socket.destroy(); } catch { } resolve(value); } };
    socket.on('data', (chunk) => {
      got += chunk.toString('latin1');
      if (/^HTTP\/\d\.\d/.test(got)) done(true); // 有 HTTP 状态行就够
    });
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
    socket.on('close', () => done(/^HTTP\/\d\.\d/.test(got)));
  });
}

/**
 * 发现 DSH 的 baseUrl。
 * @param {{preferred?:string, extraPorts?:number[], timeoutMs?:number, useCache?:boolean,
 *          skipSystemPorts?:boolean}} opts
 * @returns {Promise<{baseUrl:string|null, port:number|null, candidates:number[], source:string}>}
 */

/**
 * 这个端口到底是不是 DSH？
 *
 * 只看「有没有 HTTP 响应」不够：真实事故里 9230 端口上有别的服务，对 `/` 返回 404，
 * 照样被当成 DSH，于是事件流永远 0 帧。DSH 的 `/api/ping` 要么 200、要么 401（需要鉴权），
 * 别的服务对它只会给 404。
 */
/**
 * 这个端口到底是不是 DSH？三态返回，避免"拿不准就否掉"。
 *
 *   'yes'     200 / 401 / 403 —— /api/ping 端点存在（DSH 需要鉴权时给 401）
 *   'no'      404 —— 端点不存在，多半是别的 HTTP 服务（真实事故：9230 上的其他服务）
 *   'unknown' 超时 / 连接重置 / 其它状态码 —— 拿不准，交给上层按老逻辑处理
 *
 * 为什么要 unknown：实测 DSH 对**未鉴权的连续探测**会超时或直接 RST，
 * 若把这种情况判成"不是 DSH"，自动发现就会把真正的 DSH 排除掉。
 */
export function probeDshSignature(port, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: timeoutMs }, (res) => {
      const code = res.statusCode || 0;
      if (code === 200 || code === 401 || code === 403) done('yes');
      else if (code === 404) done('no');
      else done('unknown');
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); done('unknown'); });
    req.on('error', () => done('unknown'));
  });
}

export async function discoverDshBaseUrl(opts = {}) {
  const preferred = String(opts.preferred ?? '').trim();
  const cacheKey = preferred;
  if (opts.useCache !== false) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  }
  const candidates = [];
  const push = (p) => {
    const port = Number(p);
    if (Number.isInteger(port) && port > 0 && port < 65536 && !candidates.includes(port)) candidates.push(port);
  };
  // 顺序：环境变量 → 已在用的端口 → 系统报的 DSH 端口 → 常见默认
  // （环境变量由 DSH 注入给子进程，比"按进程名扫端口"更准；见上游 #63）
  const fromEnv = dshUrlFromEnv(opts.env ?? process.env);
  const envPort = /:(\d{2,5})\/?$/.exec(fromEnv)?.[1];
  if (envPort) push(envPort);
  const preferredPort = /:(\d{2,5})\/?$/.exec(preferred)?.[1];
  if (preferredPort) push(preferredPort);
  // skipSystemPorts 是给**单测/受控环境**用的：真机上系统里那个 DSH 端口会先于测试端口被选中，
  // 断言就永远依赖"本机此刻 DSH 是否在跑"。它也让"只信配置、不问系统"成为一种可选行为。
  // 系统里属于 DSH 进程的监听端口：这是 OS 给的事实，直接采信。
  const systemPorts = new Set();
  if (!opts.skipSystemPorts) {
    for (const p of await listDshListeningPorts({ timeoutMs: opts.timeoutMs })) {
      push(p);
      systemPorts.add(String(p));
    }
  }
  for (const p of opts.extraPorts ?? []) push(p);
  push(3080);

  for (const port of candidates) {
    // eslint-disable-next-line no-await-in-loop
    // eslint-disable-next-line no-await-in-loop
    // 判定规则（实测出来的）：
    //   · 签名明确 no（/api/ping 404）→ 一定不是 DSH，哪怕是 DSH 进程开的端口
    //     （同一个 DSH 可能同时监听多个端口，其中有的只是别的服务，比如 9230）
    //   · 签名 yes（200/401/403）→ 是 DSH
    //   · 签名 unknown（裸探测没响应/超时）→ 只有"进程确实属于 DSH"才采信
    //     因为 DSH 对未鉴权的裸请求可能完全不响应，不能因此把真身排除掉
    const trusted = systemPorts.has(String(port));
    // eslint-disable-next-line no-await-in-loop
    const sig = await probeDshSignature(port, { timeoutMs: opts.timeoutMs });
    // eslint-disable-next-line no-await-in-loop
    const alive = sig === 'yes' || (sig === 'unknown' && (trusted || await probeHttpPort(port, { timeoutMs: opts.timeoutMs })));
    if (alive) {
      const result = {
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        candidates,
        source: String(port) === String(preferredPort) ? 'configured' : 'discovered'
      };
      cache.set(cacheKey, { at: Date.now(), result });
      return result;
    }
  }
  const result = { baseUrl: null, port: null, candidates, source: 'not-found' };
  cache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/** 供测试/运维清缓存。 */
export function resetDshPortCache() { cache.clear(); }
