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

export const BEAT_INTERVAL_MS = 30_000;
export const STALE_MS = 90_000;

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 1) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 抢锁。
 * @returns {{ok:true, release:()=>void} | {ok:false, holder:object}}
 */
export function acquireInstanceLock(file, { instanceId = 'default', pid = process.pid, now = Date.now(), staleMs = STALE_MS } = {}) {
  const cur = readLock(file);
  const alive = cur && cur.beatAt && now - cur.beatAt < staleMs;
  if (alive && cur.instanceId !== instanceId) {
    return { ok: false, holder: cur };
  }
  const info = { instanceId, pid, hostname: os.hostname(), since: cur?.instanceId === instanceId ? (cur.since || now) : now, beatAt: now };
  writeLock(file, info);
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
