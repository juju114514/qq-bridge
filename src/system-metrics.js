// 系统资源可观测性（0.4.48）。
//
// 由来（2026-10-31）：有用户的服务器上跑了网页版抖音自动化，把 CPU/内存吃满，
// 于是 QQ 侧表现为"回复很慢 / 不回 / 掉线"。我们当时**拿不出任何资源证据**，
// 只能靠猜。这个模块就是让 /health/detail 能一句话回答：
//   "是我们卡了，还是服务器被别的进程吃满了？"
//
// 三个指标最关键：
//   · eventLoopLagMs —— Node 自己的卡顿（**最能说明"我们被拖累"**）
//   · cpuPercent     —— 本进程占用
//   · freeMemMb      —— 系统剩余内存（含总内存，便于判断别人吃了多少）
import os from 'node:os';

const SAMPLE_MS = 1000;
const KEEP = 60; // 保留最近 60 个采样（1 分钟）

/** 事件循环延迟监控：每秒打一次点，比较实际时间与期望时间的偏差。 */
export function startEventLoopMonitor({ intervalMs = SAMPLE_MS, onWarn = null, warnMs = 500 } = {}) {
  /** @type {number[]} */
  const lags = [];
  let last = Date.now();
  let timer = null;
  let lastWarnAt = 0;

  function tick() {
    const now = Date.now();
    const drift = Math.max(0, now - last - intervalMs);
    last = now;
    lags.push(drift);
    if (lags.length > KEEP) lags.shift();
    if (drift >= warnMs && now - lastWarnAt > 60_000) {
      lastWarnAt = now;
      try { onWarn?.(drift, lags.slice()); } catch { /* ignore */ }
    }
  }

  timer = setInterval(tick, intervalMs);
  timer?.unref?.();

  return {
    stop() { try { clearInterval(timer); } catch { /* ignore */ } },
    /** 最近一次延迟 + 最近 60 秒最大值 */
    read() {
      const lastLag = lags.length ? lags[lags.length - 1] : 0;
      const maxLag = lags.length ? Math.max(...lags) : 0;
      return { eventLoopLagMs: lastLag, eventLoopLagMaxMs: maxLag, samples: lags.length };
    },
  };
}

/** CPU 占用：用两次 process.cpuUsage() 的差值算（近似，稳过瞬间值）。 */
export function createCpuSampler() {
  let prev = process.cpuUsage();
  let prevAt = Date.now();
  return function readCpuPercent() {
    const now = Date.now();
    const cur = process.cpuUsage();
    const elapsedMs = Math.max(1, now - prevAt);
    const usedMs = ((cur.user - prev.user) + (cur.system - prev.system)) / 1000;
    const pct = Math.max(0, Math.min(100 * os.cpus().length, Math.round((usedMs / elapsedMs) * 1000) / 10));
    prev = cur;
    prevAt = now;
    return pct;
  };
}

/** 一次性快照：把"我们能观测到的"都摊开。 */
export function readSystemSnapshot({ lag = null, cpuPercent = 0 } = {}) {
  const mem = process.memoryUsage();
  const total = os.totalmem();
  const free = os.freemem();
  const mb = (n) => Math.round((n / (1024 * 1024)) * 10) / 10;
  const load = typeof os.loadavg === 'function' ? os.loadavg() : [0, 0, 0];
  const lagMs = Number(lag?.eventLoopLagMs ?? 0);
  const lagMax = Number(lag?.eventLoopLagMaxMs ?? 0);
  const freeMb = mb(free);

  // 判定：这不是"我们坏了"，而是"我们被环境拖慢了"
  const warn = [];
  if (lagMs >= 500) warn.push(`event-loop-lag:${lagMs}ms`);
  if (lagMax >= 2000) warn.push(`event-loop-lag-max:${lagMax}ms`);
  if (freeMb < 200) warn.push(`low-memory:${freeMb}MB`);
  if (cpuPercent >= 80) warn.push(`high-cpu:${cpuPercent}%`);

  return {
    cpuPercent,
    rssMb: mb(mem.rss),
    heapUsedMb: mb(mem.heapUsed),
    freeMemMb: freeMb,
    totalMemMb: mb(total),
    memUsedPercent: Math.round((1 - free / total) * 1000) / 10,
    // Windows 上 os.loadavg() 恒为 [0,0,0]，如实标注，不假装有值
    loadavg: process.platform === 'win32' ? null : load.map((n) => Math.round(n * 100) / 100),
    eventLoopLagMs: lagMs,
    eventLoopLagMaxMs: lagMax,
    cores: os.cpus().length,
    platform: process.platform,
    warn,
    at: new Date().toISOString(),
  };
}