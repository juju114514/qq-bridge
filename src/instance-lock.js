// 实例互斥锁：同一个官方机器人，只允许一个进程连 gateway。
//
// 为什么必须有：官方 WebSocket 对同一 bot 基本是"单连接"语义 —— 第二个进程连上来，
// 网关会把其中一个踢掉；两个进程各自重连，就是无限互踢（表现为消息时有时无）。
//
// ── 0.4.49.3：互斥交给操作系统内核（回环端口绑定）──────────────────────────
//
// 三轮复核的结论：**文件协议（含 .guard sidecar）做不出严格互斥** ——
// 任何"读-判断-删"都有 TOCTOU；而 Node 在 Windows 上以共享模式打开文件，
// 连"句柄还在所以不能 rename"这个证明也不成立（实测 rename/删除都成功）。
//
// 现在的做法：在 127.0.0.1 上**绑定一个固定端口**：
//   · 内核保证同一端口只能被一个进程 listen → 真正的互斥，无 TOCTOU
//   · 进程崩溃/被 kill → 内核立即释放端口 → 下一个实例直接绑定成功
//     （**不需要人工删锁，也不存在残留 guard**）
//   · 状态文件只用于诊断（谁占着、什么时候心跳），**不承担互斥职责**；
//     它坏了/被删了都不影响正确性
//
// 端口怎么定（复核指出「200 个端口不够」）：
//   1) `QQB_LOCK_PORT` 显式指定 —— 多 bot 同机部署**应该用这个**，零碰撞
//   2) 未指定时按 instanceId 派生（31200 + sha256 % 2000）
//   3) 碰撞时 **fail-closed**，并且把错误码分开报：EADDRINUSE / EACCES / EADDRNOTAVAIL / timeout
//      —— 绝不"被占就试下一个端口"：两个相同 instanceId 的启动进程可能各抢一个备用端口，
//         最终同时得锁，那正是我们要防的双实例
//
// 已知边界（写进文档，不要让部署方误以为跨机器也安全）：
//   · 宿主机多进程、同容器多进程、Linux `--network host` → 互斥成立
//   · 普通 Docker bridge / Docker Desktop 默认网络 / 两台机器 → **不互斥**

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson } from './atomic-write.js';

export const BEAT_INTERVAL_MS = 30_000;
const PORT_BASE = 31200;
const PORT_RANGE = 2000;

/** 按实例名派生端口（同一 instanceId 必须算出同一个端口）。 */
export function lockPortFor(instanceId = 'default', base = PORT_BASE, range = PORT_RANGE) {
  const h = crypto.createHash('sha256').update(String(instanceId)).digest();
  return base + (h.readUInt16BE(0) % range);
}

/** 解析锁端口：显式配置优先（复核建议：多 bot 同机必须显式配）。 */
export function resolveLockPort({ instanceId = 'default', port, env = process.env } = {}) {
  const raw = port ?? env?.QQB_LOCK_PORT;
  // 没配 → 派生。配了就必须合法：**不静默回退**（复核 P2：运维会以为配好的端口生效了）
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { port: lockPortFor(instanceId), source: 'derived' };
  }
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
    return { port: 0, source: 'invalid', reason: 'invalid-port', raw: String(raw) };
  }
  return { port: n, source: 'explicit' };
}

/** 读状态（诊断用；读不到返回 null）。 */
export function readLock(file, { fs: fsImpl = fs } = {}) {
  try {
    const raw = JSON.parse(fsImpl.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || typeof raw !== 'object') return null;
    return {
      instanceId: String(raw.instanceId ?? ''),
      pid: Number(raw.pid) || 0,
      hostname: String(raw.hostname ?? ''),
      since: Number(raw.since) || 0,
      beatAt: Number(raw.beatAt) || 0,
      token: String(raw.token ?? ''),
      port: Number(raw.port) || 0,
    };
  } catch { return null; }
}

/** 写状态（原子写：复核指出 writeFileSync 会出现短暂空文件）。 */
export function writeLock(file, info) {
  // 原子写走仓库唯一实现（它内部用全局 fs）。这里**不提供 fs 注入**：
  // 上一版留了个未使用的 fs 参数，复核指出那会让调用方误以为支持注入。
  try { atomicWriteJson(file, info); } catch { /* 诊断文件写失败不该影响主流程 */ }
}

/** 把 bind 的错误码翻译成可行动的原因（复核要求：不能混成一个"被占用"）。 */
export function classifyBindError(code = '') {
  const c = String(code);
  // 只能说"端口被占"：占着它的可能是本 bot 的另一个实例，也可能是**别的程序**
  // （复核：无条件声称"是同实例"会误导排障方向）
  if (c === 'EADDRINUSE') return { reason: 'held', hint: '端口已被占用（可能是另一个实例，也可能是别的程序）' };
  if (c === 'EACCES' || c === 'EPERM') return { reason: 'permission', hint: '无权限绑定该端口（<1024 需要特权）' };
  if (c === 'EADDRNOTAVAIL') return { reason: 'unavailable', hint: '绑定地址在本机不可用' };
  if (c === 'timeout') return { reason: 'timeout', hint: '绑定超时（网络栈异常）' };
  return { reason: 'error', hint: `绑定失败：${c || 'unknown'}` };
}

/**
 * 抢锁（异步：需要 bind 端口）。
 *
 * @returns {Promise<{ok:true, release, token, info, beatNow, stats}
 *          | {ok:false, holder, reason, hint}>}
 */
/**
 * 带上限的 bind（0.4.49.3）。抽成独立函数是为了**能对超时路径做注入式测试** ——
 * 真实 socket 上很难稳定制造"listen 既不 listening 也不 error"的局面。
 *
 * 三条硬规则（第 4 轮复核）：
 *   1. 超时必须**主动关闭** server，不能留下没人持有却占着端口的 listener
 *   2. 成功/失败都要清掉定时器，否则成功后迟到的事件会把刚拿到的锁关掉
 *   3. 迟到的 listening：只有"已经以失败收场"时才关闭（用 accepted 判断，不能用 settled ——
 *      成功路径里 settled 也是 true）
 */
export function bindWithTimeout(server, { port, host = '127.0.0.1', timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let accepted = false;
    // 不能 unref：unref 后如果事件循环恰好空了，进程会先退出，Promise 永不 settle
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);

    function closeQuietly() { try { server.close(); } catch { /* ignore */ } }
    function finish(ok, code = '') {
      if (settled) return;
      settled = true;
      if (ok) { accepted = true; clearTimeout(timer); } else { clearTimeout(timer); closeQuietly(); }
      resolve({ ok, code });
    }

    server.once('error', (error) => finish(false, String(error?.code ?? 'EUNKNOWN')));
    // 用 microtask 等本轮监听器（含 listen() 的回调）跑完再判断：
    // 直接同步判断会先于回调执行，把刚成功的 listener 当成"迟到的孤儿"关掉。
    server.once('listening', () => {
      queueMicrotask(() => {
        if (!accepted) closeQuietly();
        else clearTimeout(timer);
      });
    });
    try {
      server.listen({ port, host, exclusive: true }, () => finish(true));
    } catch (error) { finish(false, String(error?.code ?? 'EUNKNOWN')); }
  });
}

export async function acquireInstanceLock(file, {
  instanceId = 'default', pid = process.pid, port, host = '127.0.0.1',
  fs: fsImpl = fs, log = () => {}, env = process.env,
} = {}) {
  const resolved = resolveLockPort({ instanceId, port, env });
  if (resolved.source === 'invalid') {
    log(`⚠️ [official] QQB_LOCK_PORT 非法（${resolved.raw}）：应为 1-65535 的整数。`
      + '为避免"以为配好了其实没生效"，本实例直接不连官方通道。');
    return { ok: false, holder: null, reason: 'invalid-port', hint: `QQB_LOCK_PORT=${resolved.raw} 不是合法端口` };
  }
  const { port: listenPort, source } = resolved;
  const token = crypto.randomUUID();

  const server = net.createServer((socket) => { try { socket.destroy(); } catch { /* ignore */ } });
  server.unref?.();

  const bound = await bindWithTimeout(server, { port: listenPort, host, timeoutMs: 3000 });

  if (!bound.ok) {
    const { reason, hint } = classifyBindError(bound.code);
    const holder = readLock(file, { fs: fsImpl });
    log(`⚠️ [official] 无法取得实例锁（端口 ${listenPort}，来源=${source}）：${hint}`
      + (holder ? `；当前持有者 instance=${holder.instanceId} pid=${holder.pid} host=${holder.hostname}` : '')
      + (reason === 'held'
        ? ` —— 本实例不连官方通道（如果是别的程序占了端口，请改 QQB_LOCK_PORT 或换实例名）。`
        : ''));
    return { ok: false, holder, reason, hint };
  }

  // 端口拿到 = 互斥成立。之后的状态文件纯属诊断。
  const since = Date.now();
  const info = { instanceId, pid, hostname: os.hostname(), since, beatAt: since, token, port: listenPort };
  writeLock(file, info);

  let timer = null;
  let beats = 0;
  const beat = () => {
    try { beats += 1; writeLock(file, { ...info, beatAt: Date.now() }); }
    catch { /* ignore */ }
  };
  timer = setInterval(beat, BEAT_INTERVAL_MS);
  timer.unref?.();

  // 复核 P1：release 必须**等待** close 完成，否则调用方立刻重取会撞 EADDRINUSE
  const release = () => new Promise((resolve, reject) => {
    if (timer) clearInterval(timer);
    timer = null;
    let done = false;
    let fallback = null;
    const cleanupFile = () => {
      try {
        const own = readLock(file, { fs: fsImpl });
        // 只删自己写的那一份；别人接管后不要动文件
        if (own && own.token === token) fsImpl.rmSync(file, { force: true });
      } catch { /* ignore */ }
    };
    const settle = (error) => {
      if (done) return;                  // 幂等：close 回调与兜底只生效一次
      done = true;
      if (fallback) clearTimeout(fallback);
      if (error) reject(error); else resolve();
    };
    try {
      if (!server.listening) { cleanupFile(); return settle(); }
      // 兜底只负责"不卡死"，**不能**把超时当成释放成功（复核第 2 点）
      // 同样不能 unref：等待 close 期间进程不能被判定为"没事可做"
      fallback = setTimeout(() => { cleanupFile(); settle(new Error('release-timeout')); }, 2000);
      server.close(() => { cleanupFile(); settle(); });
    } catch { cleanupFile(); settle(); }
  });

  return { ok: true, release, token, info, beatNow: beat, stats: () => ({ beats, port: listenPort, source }) };
}
