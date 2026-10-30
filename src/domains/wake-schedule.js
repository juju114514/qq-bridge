// 唤醒排程 —— 波次 2 第三块，也是社交行为里"最容易被并发绕晕"的一段。
//
// 它要同时处理四件事，而且**顺序不能换**：
//   1. 总开关 / 暂停        —— 关了就什么都不做
//   2. 静默时段             —— 只拦"自己去搭话"的唤醒，管理员指令照旧
//   3. 合并窗口已有待发唤醒 —— 按优先级**升级**原因（先概率后 @ 不能被当成概率唤醒）
//   4. 会话正忙             —— 不丢，暂存进 pendingWakeReasons（有界 20 条）
//
// 三个真实事故写在下面：
//   · 合并窗口只看 `st.pendingWakeTimer`：漏了就会排两个定时器，到点醒两次
//   · 繁忙时必须**暂存**而不是丢弃：丢了就是"AI 明明被叫了却完全没反应"
//   · 清理 sleepTimer：不清理会出现"有限潜水定时器 + 唤醒定时器"同时活着

export const WAKE_QUEUE_MAX = 20;
export const DEFAULT_BATCH_MS = 8000;

/**
 * @returns {{ action: 'disabled'|'paused'|'quiet'|'disallowed'|'merged'|'busy'|'scheduled',
 *             reason?: string, delayMs?: number, upgraded?: boolean }}
 */
export function scheduleWake({
  key,
  reason,
  enabled = true,
  paused = false,
  quietRange = null,
  silenceWake = () => false,
  inQuiet = () => false,
  now = Date.now,
  allowed = () => true,
  getState,
  priorityOf = () => 0,
  isBusy = () => false,
  busyReason = () => '',
  cancelReplyCheck = () => {},
  onFire = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = () => {},
  batchWindowDefault = DEFAULT_BATCH_MS,
  queueMax = WAKE_QUEUE_MAX
} = {}) {
  if (!enabled) return { action: 'disabled' };
  if (paused) return { action: 'paused' };

  // 静默时段：只拦"自己去搭话"的唤醒（定时器/概率/@），管理员指令与引导照旧。
  // 消息本身已在 handleIncoming 里记录，醒来后仍能看到这段时间发生了什么。
  if (quietRange && silenceWake(reason) && inQuiet(now(), quietRange)) {
    log(`[reserved2] 静默时段（${String(quietRange[0]).padStart(2, '0')}:00~${String(quietRange[1]).padStart(2, '0')}:00）内不主动唤醒（${reason}）`);
    return { action: 'quiet' };
  }

  if (!allowed(key)) {
    log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
    return { action: 'disallowed' };
  }

  const st = getState(key);

  // 合并窗口内已有待发送唤醒：按优先级升级最终原因，
  // 避免"先概率后 @"却仍按概率唤醒。
  if (st.pendingWakeTimer) {
    const cur = st.pendingWakeReason || reason;
    if (priorityOf(reason) > priorityOf(cur)) {
      st.pendingWakeReason = reason;
      log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      return { action: 'merged', reason, upgraded: true };
    }
    return { action: 'merged', reason: cur, upgraded: false };
  }

  // 会话正忙（上一轮还没结束）：暂存原因，等这一轮结束由 replay 处理。
  // 不能丢 —— 丢了表现就是"被 @ 了却完全没反应"。
  if (isBusy(key, st)) {
    if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
    const seq = st.lastUnreadSeq || 0;
    if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
      st.pendingWakeReasons.push({ reason, seq });
      // 有界队列：最多保留 queueMax 条，防止消息洪峰下无限增长
      if (st.pendingWakeReasons.length > queueMax) {
        st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - queueMax);
      }
    }
    log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReason(key, st)}）`);
    return { action: 'busy' };
  }

  // 真实唤醒已接管：取消普通回复检查，避免 30s 后再补一刀
  cancelReplyCheck(key);

  // 有限潜水定时器与唤醒定时器不能同时活着
  if (st.sleepTimer) {
    clearTimeoutFn(st.sleepTimer);
    st.sleepTimer = null;
  }

  st.pendingWakeReason = reason;
  const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || batchWindowDefault);
  st.pendingWakeTimer = setTimeoutFn(() => {
    st.pendingWakeTimer = null;
    const finalReason = st.pendingWakeReason || reason;
    st.pendingWakeReason = null;
    onFire(key, finalReason);
  }, batchMs);
  // 与其它 per-conversation 定时器一致：别让待唤醒定时器把进程钉住
  st.pendingWakeTimer?.unref?.();
  log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  return { action: 'scheduled', reason, delayMs: batchMs };
}