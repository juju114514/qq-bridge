// 回合收尾：reserved2 的「防遗忘」判定。
//
// 机制：每次唤醒回合结束时，如果 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
// 就发一条提醒；连续漏达到上限（默认 2）后，把唤醒配置重置成默认值 ——
// 否则 AI 会既不说、也不再被唤醒，会话彻底静默。
//
// 为什么单独抽：这段有三条出口（已设置 / 该提醒 / 该重置），
// 而且"已设置"的判断有两个来源（set_wake_config 或 mark_read），
// 藏在 pumpMux 里只能靠真机试。抽出来后可以穷举。

/**
 * @returns {{ action: 'none'|'settled'|'remind'|'reset', missCount: number }}
 *   none    —— 本轮不在等待唤醒配置（或没有 pending 标记）
 *   settled —— AI 已经设置过（set_wake_config / mark_read），清计数
 *   remind  —— 还没设置，但没到上限 → 发提醒，计数 +1
 *   reset   —— 连续漏到上限 → 重置为默认唤醒配置
 */
export function decideWakeReminder({
  pending = false,
  wakeConfigUpdated = false,
  markReadCalled = false,
  missCount = 0,
  maxReminders = 2
} = {}) {
  const current = Number(missCount) || 0;
  if (!pending) return { action: 'none', missCount: current };

  // 只要本轮"设过"或"标读过"，就算交代过了 —— 语义上都是"AI 处理了这一轮"
  if (wakeConfigUpdated || markReadCalled) return { action: 'settled', missCount: 0 };

  const max = Math.max(1, Number(maxReminders) || 2);
  const next = current + 1;
  if (next < max) return { action: 'remind', missCount: next };
  return { action: 'reset', missCount: next };
}