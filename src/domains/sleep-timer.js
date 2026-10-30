// 有限潜水的"到点叫醒"定时器 —— 波次 2 第二块。
//
// 这段的核心不是 setTimeout，而是两个必须记住的坑：
//
//   1. **Node 的 setTimeout 超过 2^31-1ms 会按 1ms 触发**（立即醒）。
//      所以远未来定时器不能一次设完，要分段续期。
//   2. 续期步长刻意取 **100 秒**而不是"24 天上限"：
//      每次续期都用 Date.now() 重算剩余时间，系统时钟被校正/跳变时能很快纠正。
//      用满上限的话，时钟往回跳就会多睡很久。
//
// 另外"设置定时器"这件事本身有语义：**先取消旧的，再按当前 WakeConfig 决定要不要设**。
// 顺序错了会出现"两套定时器同时活着，到点醒两次"。

export const SLEEP_TIMER_MAX_MS = 100009;

/**
 * @returns {{ action: 'disabled'|'not-allowed'|'paused'|'none'|'invalid'|'woke'|'scheduled'|'scheduled-long',
 *             delayMs?: number, reason?: string }}
 */
export function setupSleepTimer({
  key,
  st,
  wakeConfig,
  enabled = true,
  paused = false,
  allowed = () => true,
  cancelReplyCheck = () => {},
  onWake = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
  log = () => {},
  isOfficialKey = (k) => String(k).includes('official-'),
  maxTimeoutMs = SLEEP_TIMER_MAX_MS
} = {}) {
  if (!enabled) return { action: 'disabled' };

  if (!allowed(key)) {
    if (isOfficialKey(key)) log(`[official] 会话未通过当前模式校验，丢弃：${key}`);
    return { action: 'not-allowed' };
  }

  // 有限睡眠配置已接管，取消"普通回复检查"
  cancelReplyCheck(key);

  // 先清旧定时器：否则会出现两套定时器同时活着、到点醒两次
  if (st?.sleepTimer) {
    clearTimeoutFn(st.sleepTimer);
    st.sleepTimer = null;
  }

  if (paused) return { action: 'paused' };

  const wc = wakeConfig;
  if (!wc || wc.infinite || !wc.sleepUntil) return { action: 'none' };

  const until = Date.parse(wc.sleepUntil);
  if (!Number.isFinite(until)) return { action: 'invalid' };

  const delay = until - now();
  if (delay <= 0) {
    // 已经到期：直接醒，不用再挂定时器
    onWake(key, 'timeout');
    return { action: 'woke' };
  }

  if (delay > maxTimeoutMs) {
    st.sleepTimer = setTimeoutFn(() => {
      st.sleepTimer = null;
      setupSleepTimer({ key, st, wakeConfig, enabled, paused, allowed, cancelReplyCheck, onWake, setTimeoutFn, clearTimeoutFn, now, log, isOfficialKey, maxTimeoutMs });
    }, maxTimeoutMs);
    st.sleepTimer?.unref?.();
    log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(maxTimeoutMs / 1000)} 秒后续期`);
    return { action: 'scheduled-long', delayMs: maxTimeoutMs };
  }

  st.sleepTimer = setTimeoutFn(() => {
    st.sleepTimer = null;
    onWake(key, 'timeout');
  }, delay);
  st.sleepTimer?.unref?.();
  log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  return { action: 'scheduled', delayMs: delay };
}