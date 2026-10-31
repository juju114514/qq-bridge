// 实例互斥锁：同一个官方机器人，**只允许一个进程**连 gateway。
//
// 为什么必须有：官方 WebSocket 对同一 bot 基本是"单连接"语义 —— 第二个进程连上来，
// 网关会把其中一个踢掉；两个进程各自重连，就是无限互踢（表现为消息时有时无）。
// 宿主机桥接 + Docker 容器同时跑，正是这个场景。
//
// 设计：
//   · 锁文件 state/official-instance.lock，内容 { instanceId, pid, hostname, since, beatAt }
//   · 心跳：持有者每 30 秒刷 beatAt；超过 90 秒没刷新视为残留，可被接管
//   · 释放：正常退出删锁；被强杀留下的锁靠心跳过期回收

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson } from './atomic-write.js';
import { isPidAlive } from './pid-alive.js';

export const BEAT_INTERVAL_MS = 30_000;
export const STALE_MS = 90_000;

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ } };

/**
 * 用 sidecar 文件把"检查 + 创建"串起来（0.4.49，外部审查 P2-3）。
 *
 * 旧实现是 `readLock()` → 判断 → `writeLock()`：两个进程同时看到"无锁/过期"时
 * 会都写锁并各自返回 ok —— 于是同一个官方机器人被连了两次（互踢线）。
 *
 * 做法与 channel-mode-store 一致：`openSync(guard, 'wx')` 独占创建 = 跨进程互斥；
 * 拿到 guard 的人做检查+写入；guard 超过 5 秒未释放视为残留并强占。
 */
function withGuard(fs, guardFile, fn, { retries = 40, delayMs = 5, staleMs = 5000 } = {}) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const fd = fs.openSync(guardFile, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } catch { /* ignore */ }
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { return fn(); }
      finally { try { fs.rmSync(guardFile, { force: true }); } catch { /* ignore */ } }
    } catch (error) {
      if (String(error?.code ?? '') !== 'EEXIST') throw error;
      // 残留 guard：持有者已死或写入卡住超过 5 秒
      try {
        const st = fs.statSync(guardFile);
        if (Date.now() - st.mtimeMs > staleMs) { fs.rmSync(guardFile, { force: true }); continue; }
      } catch { /* 已被别人清掉，重试即可 */ }
      sleepSync(delayMs);
    }
  }
  // 抢不到 guard = 有人在并发认领：保守失败（不冒险写锁）
  return { __guardTimeout: true };
}

export function readLock(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || typeof raw !== 'object') return null;
    return {
      instanceId: String(raw.instanceId ?? ''),
      pid: Number(raw.pid) || 0,
      hostname: String(raw.hostname ?? ''),
      since: Number(raw.since) || 0,
      beatAt: Number(raw.beatAt) || 0
    };
  } catch {
    return null;
  }
}

export function writeLock(file, info) {
  // 原子写走唯一实现：固定 .tmp 名 + 无失败清理 = 并发下会互相覆盖临时文件
  atomicWriteJson(file, info);
}

/**
 * 抢锁。
 * @returns {{ok:true, release:()=>void} | {ok:false, holder:object}}
 */
export function acquireInstanceLock(file, { instanceId = 'default', pid = process.pid, now = Date.now(), staleMs = STALE_MS, fs: fsImpl = fs, killFn } = {}) {
  const guardFile = `${file}.guard`;
  const decided = withGuard(fsImpl, guardFile, () => {
    const cur = readLock(file);
    const alive = cur && cur.beatAt && now - cur.beatAt < staleMs;
    if (alive) {
      // 0.4.49（外部审查 P2-3）：同 instanceId 换 PID 不再**无条件**接管。
      //   规则：老进程还活着 → 拒绝（防双实例）；老进程已死 → 允许（重启不误报）。
      // 旧行为只看 instanceId，同实例的另一个进程可以直接覆盖战领。
      if (cur.instanceId !== instanceId) return { ok: false, holder: cur };
      if (cur.pid && cur.pid !== pid && isPidAlive(cur.pid, killFn)) {
        return { ok: false, holder: cur };
      }
    }
    const info = {
      instanceId, pid, hostname: os.hostname(),
      since: cur?.instanceId === instanceId ? (cur.since || now) : now,
      beatAt: now,
    };
    writeLock(file, info);
    return { ok: true, info };
  });
  if (!decided || decided.__guardTimeout) {
    return { ok: false, holder: { instanceId: '(并发认领中)', pid: 0, hostname: '', since: 0, beatAt: 0 } };
  }
  if (!decided.ok) return { ok: false, holder: decided.holder };
  let timer = null;
  const beat = () => {
    try {
      const own = readLock(file);
      // 只刷自己的锁：被别人接管后不能再把锁抢回来
      if (own && own.instanceId === instanceId && own.pid === pid) writeLock(file, { ...own, beatAt: Date.now() });
    } catch { /* ignore */ }
  };
  timer = setInterval(beat, BEAT_INTERVAL_MS);
  timer.unref?.();
  const release = () => {
    if (timer) clearInterval(timer);
    timer = null;
    try {
      const own = readLock(file);
      if (own && own.instanceId === instanceId && own.pid === pid) fs.rmSync(file, { force: true });
    } catch { /* ignore */ }
  };
  return { ok: true, release };
}
