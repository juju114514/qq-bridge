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

const CACHE_MS = 20000;
const cache = new Map(); // key(baseUrl|'') → { at, result }

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
  // 顺序：已在用的端口 → 系统报的 DSH 端口 → 常见默认
  const preferredPort = /:(\d{2,5})\/?$/.exec(preferred)?.[1];
  if (preferredPort) push(preferredPort);
  // skipSystemPorts 是给**单测/受控环境**用的：真机上系统里那个 DSH 端口会先于测试端口被选中，
  // 断言就永远依赖"本机此刻 DSH 是否在跑"。它也让"只信配置、不问系统"成为一种可选行为。
  if (!opts.skipSystemPorts) {
    for (const p of await listDshListeningPorts({ timeoutMs: opts.timeoutMs })) push(p);
  }
  for (const p of opts.extraPorts ?? []) push(p);
  push(3080);

  for (const port of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await probeHttpPort(port, { timeoutMs: opts.timeoutMs })) {
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
