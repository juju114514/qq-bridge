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
// 状态文件格式版本：以后改结构时靠它做兼容分支
export const SCHEMA_VERSION = 1;
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
/**
 * 尝试认领通道。
 *
 * epoch 是 **fencing token**：每次「重新取得所有权」（free / stale / 从别的 mode 抢过来）都 +1，
 * 而**同一持有者的续期（refresh）不 +1** —— 续期不是换主人。
 *
 * 单调性要求：epoch 一旦用过就永远不能再用（即使进程崩溃、文件被释放）。
 * 因此 `floorEpoch` 由调用方传入（读自持久化的 epoch 水位文件），
 * 保证「文件被删了再重建」也不会把 12 退回 1。
 */
export function claimMode({
  current, mode, pid, now = Date.now(), ttlMs = DEFAULT_TTL_MS, note = '', floorEpoch = 0,
}) {
  const base = Math.max(Number(current?.epoch) || 0, Number(floorEpoch) || 0);
  const build = (epoch, status = 'active') => ({
    schemaVersion: SCHEMA_VERSION, mode, pid, epoch, status, at: now, note,
  });
  if (!current) return { ok: true, record: build(base + 1), reason: 'free' };
  // 已显式释放的认领等于"空闲"，但它带着 epoch 水位 → 新主人从 base+1 起算
  if (String(current.status ?? 'active') === 'released') {
    return { ok: true, record: build(base + 1), reason: 'released' };
  }
  if (!isFresh(current, now, ttlMs)) return { ok: true, record: build(base + 1), reason: 'stale' };
  if (current.mode === mode) {
    // 同模式：同 pid 就是续期（epoch 不变）；不同 pid 说明上一个同类实例还活着 → 拒绝
    if (String(current.pid) === String(pid)) {
      return { ok: true, record: { ...current, schemaVersion: SCHEMA_VERSION, at: now, note, status: 'active' }, reason: 'refresh' };
    }
    return { ok: false, reason: 'other-active', holder: current, sameMode: true };
  }
  return { ok: false, reason: 'other-active', holder: current, sameMode: false };
}

/** 旧 epoch / 非 active / mode 不符 → 抛这个（调用方决定降级还是中止）。 */
export class StaleEpochError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'StaleEpochError';
    this.code = 'STALE_EPOCH';
    this.detail = detail;
  }
}

/**
 * 副作用边界守卫：在「真的要做一件不可撤销的事」之前调用。
 *
 * 注意：**这不是原子操作**。校验通过到副作用之间仍可能发生切换（竞态窗口），
 * 所以它只能把窗口从「整段处理耗时」缩小到「一次读文件」，
 * 真正的串行化由调用方的队列/单进程假设保证。
 */
export function assertEpochCurrent(current, { mode, epoch } = {}) {
  if (!current || typeof current !== 'object') {
    throw new StaleEpochError('通道状态不存在（可能已被释放）', { mode, epoch });
  }
  if (String(current.status ?? 'active') !== 'active') {
    throw new StaleEpochError(`通道状态不是 active：${current.status}`, { mode, epoch, status: current.status });
  }
  if (mode && String(current.mode) !== String(mode)) {
    throw new StaleEpochError(`通道已切换：${current.mode} ≠ ${mode}`, { mode, epoch, actual: current.mode });
  }
  const cur = Number(current.epoch) || 0;
  if (epoch != null && cur !== Number(epoch)) {
    throw new StaleEpochError(`epoch 已过期：${epoch} ≠ ${cur}`, { mode, epoch, actual: cur });
  }
  return true;
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
  const epoch = record.epoch != null ? `，epoch ${record.epoch}` : '';
  return `${record.mode}（pid ${record.pid}${epoch}，${age}s 前心跳${record.note ? '，' + record.note : ''}）`;
}