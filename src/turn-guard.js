// 回合收尾的"无行动计数"判定（pumpMux 里最容易写错的一段）。
//
// 背景：reserved2 模式会唤醒 AI，但 AI 可能既没发消息、也没 mark_read / set_wake_config ——
// 这种"空转回合"连续出现会让会话永远等下去。所以连续 N 次没行动就重置唤醒配置。
//
// 三处容易搞错的地方（都是真实事故）：
//   1. **turn/start 丢了**（重连后由快照补发的回合）无从判断"这一轮有没有行动"，
//      这时记 miss 会冤枉 AI —— 连续 3 次就把 AI 自己设的唤醒配置重置成默认值。
//   2. **静默回合**（摘要投喂）本来就不发消息，不能算"无行动"。
//   3. 只有 turn/start 存在时，才能用 `lastActionAt >= turnStart` 判断行动。

/**
 * @returns {{ count: number, reset: boolean, skip: string }}
 *   count  —— 新的 noActionCount
 *   reset  —— 是否达到阈值需要重置唤醒配置
 *   skip   —— 非空表示"这轮不参与计数"的原因（用于日志）
 */
export function decideNoAction({
  mode = '',
  key = '',
  isSilentTurn = false,
  turnStart = 0,
  sendToolHit = false,
  lastActionAt = 0,
  noActionCount = 0,
  limit = 3
} = {}) {
  const current = Number(noActionCount) || 0;
  const limitN = Math.max(1, Number(limit) || 3);

  // 只有 reserved2 才有这套唤醒-无行动兜底
  if (mode !== 'reserved2' || !key) return { count: current, reset: false, skip: 'not-reserved2' };
  // 静默回合（摘要投喂）不参与
  if (isSilentTurn) return { count: current, reset: false, skip: 'silent-turn' };
  // turn/start 缺失：无从判断，跳过（不要冤枉 AI）
  if (!(turnStart > 0) && !sendToolHit) return { count: current, reset: false, skip: 'no-turn-start' };

  const actionTaken = sendToolHit || (turnStart > 0 && Number(lastActionAt) >= Number(turnStart));
  if (actionTaken) return { count: 0, reset: false, skip: '' };

  const next = current + 1;
  return { count: next, reset: next >= limitN, skip: '' };
}