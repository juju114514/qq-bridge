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

import crypto from 'node:crypto';
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
function withGuard(fs, guardFile, fn, { retries = 40, delayMs = 5, staleMs = 5000, onAcquired } = {}) {
  const token = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const tmp = `${guardFile}.${token}.tmp`;

  /**
   * 原子创建 guard（0.4.49.2，复核 P2-2）。
   *
   * 旧写法 `openSync(guard,'wx')` 之后再 writeSync(pid)：两步之间别的进程会读到**空文件**，
   * 于是 holderPid=0 → isPidAlive(0)=false → 把正在创建中的 guard 当死锁回收。
   * 现在先写临时文件（内容已就绪），再用 hardlink 原子挂到 guard 名上：
   * 目标已存在就 EEXIST，不会出现"有人看得见但内容为空"的中间态。
   */
  function tryCreate() {
    fs.writeFileSync(tmp, String(process.pid));
    try {
      fs.linkSync(tmp, guardFile);
      return true;
    } catch (error) {
      const code = String(error?.code ?? '');
      if (code === 'EEXIST') return false;
      // 文件系统不支持 hardlink（部分网络盘）：退回 wx + 写入，并接受极窄窗口
      try {
        const fd = fs.openSync(guardFile, 'wx');
        try { fs.writeSync(fd, String(process.pid)); } catch { /* ignore */ }
        try { fs.closeSync(fd); } catch { /* ignore */ }
        return true;
      } catch (e2) { if (String(e2?.code ?? '') === 'EEXIST') return false; throw e2; }
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * 回收 stale guard（0.4.49.2，复核 P2-1 + P2-2）。
   *
   * 两个硬要求：
   *   1. **只删自己检查过的那个文件**：先 rename 抢占（rename 对同一名字只有一个人成功），
   *      再比对 ino/dev；如果抢到的是别人新建的 guard，就把它还回去。
   *   2. **pid 读不到 = 不知道 = 不回收**：损坏/空 guard 不再被当成死持有者。
   *      guard 正常只持有几毫秒；真出现损坏，需要人工删 `<lock>.guard`（见 TROUBLESHOOTING）。
   */
  function tryRecycle() {
    let st0;
    try { st0 = fs.statSync(guardFile); } catch { return 'gone'; }
    if (Date.now() - st0.mtimeMs <= staleMs) return 'alive';

    let holderPid = 0;
    try { holderPid = Number(fs.readFileSync(guardFile, 'utf8').trim()) || 0; } catch { holderPid = 0; }
    if (!(holderPid > 0)) return 'unknown';           // ← 保守拒绝（P2-2）
    if (isPidAlive(holderPid)) return 'alive';

    const parked = `${guardFile}.stale-${token}`;
    // guard-allow: renameSync 这里不是原子写文件，而是用 rename 的唯一性抢占“由谁来删”；
    //               抢到后还要比对 ino/dev，确认删的就是自己检查过的那个 guard。
    try { fs.renameSync(guardFile, parked); } catch { return 'gone'; }   // 抢占失败 = 别人处理了
    try {
      const st1 = fs.statSync(parked);
      const same = st1.ino === st0.ino && st1.dev === st0.dev
        && st1.birthtimeMs === st0.birthtimeMs;
      if (!same) {
        // 抢到的是别人刚创建的新 guard：原样还回去，等下一轮
        // guard-allow: renameSync 归还被别人新建的 guard（抢占后发现不是同一个文件）
        try { fs.renameSync(parked, guardFile); } catch { /* 还回去失败就只能删，避免残留 */ try { fs.rmSync(parked, { force: true }); } catch { /* ignore */ } }
        return 'raced';
      }
      try { fs.rmSync(parked, { force: true }); } catch { /* ignore */ }
      return 'recycled';
    } catch { return 'gone'; }
  }

  for (let i = 0; i < retries; i += 1) {
    if (tryCreate()) {
      try {
        if (typeof onAcquired === 'function') onAcquired();   // 测试钩子：在临界区内暂停
        return fn();
      }
      finally { try { fs.rmSync(guardFile, { force: true }); } catch { /* ignore */ } }
    }
    const verdict = tryRecycle();
    if (verdict === 'unknown') {
      // 不知道持有者是谁 → 不夺锁，等它自己结束（正常几毫秒）
      sleepSync(delayMs);
      continue;
    }
    sleepSync(delayMs);
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
      beatAt: Number(raw.beatAt) || 0,
      // generation token（0.4.49.1）：只有"当初写这条锁的人"能刷/删它。
      // 只比 pid + instanceId 不够：两个进程可能同 instanceId，而 pid 会被复用。
      token: String(raw.token ?? ''),
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
export function acquireInstanceLock(file, { instanceId = 'default', pid = process.pid, now = Date.now(), staleMs = STALE_MS, fs: fsImpl = fs, killFn, log = () => {}, guardHooks = {} } = {}) {
  const guardFile = `${file}.guard`;
  const hook = guardHooks.onAcquired;
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
      token: crypto.randomUUID(),
      since: cur?.instanceId === instanceId ? (cur.since || now) : now,
      beatAt: now,
    };
    writeLock(file, info);
    return { ok: true, info };
  }, { onAcquired: hook });
  if (!decided || decided.__guardTimeout) {
    return { ok: false, holder: { instanceId: '(并发认领中)', pid: 0, hostname: '', since: 0, beatAt: 0 } };
  }
  if (!decided.ok) return { ok: false, holder: decided.holder };
  const token = decided.info.token;
  let timer = null;
  // 0.4.49.1（R49-01）：心跳也在 guard 内做「读取身份 → 写入」，
  // 且必须比对 token —— 否则 A 读到旧锁后停顿、B 接管、A 恢复再写，就会覆盖 B。
  // 0.4.49.2（复核 P3-1）：beat 抢不到 guard 时以前是**静默**跳过，
  // 连续错过多轮会让 beatAt 变旧、被别人判过期接管 —— 至少要能看见。
  let beatGuardMisses = 0;
  let beatTokenLost = false;
  const beat = () => {
    try {
      const r = withGuard(fsImpl, guardFile, () => {
        const own = readLock(file);
        // 已被别人接管：绝不再刷（并且要让人知道）
        if (!own || own.token !== token) { beatTokenLost = true; return 'lost'; }
        writeLock(file, { ...own, beatAt: Date.now() });
        return 'ok';
      }, { onAcquired: hook });
      if (r && r.__guardTimeout) {
        beatGuardMisses += 1;
        if (beatGuardMisses === 3 || beatGuardMisses % 30 === 0) {
          log(`⚠️ [official] 心跳连续 ${beatGuardMisses} 次抢不到 guard —— 锁可能被其它实例占用`);
        }
      } else {
        if (beatGuardMisses > 0) { log(`[official] 心跳恢复（此前连续失败 ${beatGuardMisses} 次）`); }
        beatGuardMisses = 0;
        if (r === 'lost') log('⚠️ [official] 锁已被其它实例接管，本实例停止心跳（不再抢锁）');
      }
    } catch { /* ignore */ }
  };
  timer = setInterval(beat, BEAT_INTERVAL_MS);
  timer.unref?.();
  const release = () => {
    if (timer) clearInterval(timer);
    timer = null;
    try {
      // 同样进 guard + 比对 token：只删"我写的这一代"，不删别人的
      withGuard(fsImpl, guardFile, () => {
        const own = readLock(file);
        if (own && own.token === token) fs.rmSync(file, { force: true });
      });
    } catch { /* ignore */ }
  };
  // beatNow 暴露给测试：确定性触发一次心跳（生产走 30s 定时器）
  return {
    ok: true, release, token, info: decided.info, beatNow: beat,
    // 供测试/自检读取
    stats: () => ({ guardMisses: beatGuardMisses, tokenLost: beatTokenLost }),
  };
}
