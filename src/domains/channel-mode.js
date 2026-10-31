// 通道模式闸（N3）：同一份 state/ 只允许**一个**东西在收 QQ 消息。
//
// 要解决的问题不是"插件和 sidecar 都写文件"（插件只发意图，不直接写 state），
// 而是**两个通道同时处理同一条 QQ 消息** → 双回复、重复唤醒、互相顶掉。
//
// 所以用一个带心跳的认领文件：state/channel-mode.json
//   { mode: 'bridge' | 'plugin', pid, at, note }
// 规则：
//   · 认领：文件不存在 → 直接写；文件存在但**心跳过期** → 抢占（上一个实例崩了）
//   · 同一 mode 且 pid 相同 → 续期（正常刷新）
//   · 不同 mode 且心跳新鲜 → **拒绝**，调用方必须降级（不连接 QQ，只保留控制台/工具）
//
// 心跳新鲜度用 TTL（默认 60s），bridge 每 20s 刷新一次。

export const DEFAULT_TTL_MS = 60_000;
export const MODE_BRIDGE = 'bridge';
export const MODE_PLUGIN = 'plugin';

export function isFresh(record, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  if (!record || typeof record !== 'object') return false;
  const at = Number(record.at) || 0;
  if (!at) return false;
  return now - at <= ttlMs;
}

/**
 * 尝试认领通道。
 * @returns {{ ok: true, record: object, reason: 'free'|'refresh'|'stale' }
 *         | { ok: false, reason: 'other-active', holder: object }}
 */
export function claimMode({ current, mode, pid, now = Date.now(), ttlMs = DEFAULT_TTL_MS, note = '' }) {
  const record = { mode, pid, at: now, note };
  if (!current) return { ok: true, record, reason: 'free' };
  if (!isFresh(current, now, ttlMs)) return { ok: true, record, reason: 'stale' };
  if (current.mode === mode) {
    // 同模式：同 pid 就是续期；不同 pid 说明上一个同类实例还活着 → 也拒绝
    if (String(current.pid) === String(pid)) return { ok: true, record, reason: 'refresh' };
    return { ok: false, reason: 'other-active', holder: current, sameMode: true };
  }
  return { ok: false, reason: 'other-active', holder: current, sameMode: false };
}

/** 释放：只有持有者能删（避免把别人的认领删掉）。 */
export function shouldRelease(current, { mode, pid }) {
  if (!current) return false;
  return String(current.mode) === String(mode) && String(current.pid) === String(pid);
}

/** 给人看的一句话（日志/控制台横幅共用）。 */
export function describeMode(record) {
  if (!record) return '无（没有通道在认领）';
  const age = Math.max(0, Math.round((Date.now() - (Number(record.at) || 0)) / 1000));
  return `${record.mode}（pid ${record.pid}，${age}s 前心跳${record.note ? '，' + record.note : ''}）`;
}