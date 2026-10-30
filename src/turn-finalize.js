// 回合收尾后的状态清理（pumpMux 里 `if (ended)` 分支的前半段）。
//
// 为什么不和"发送回复"放一起：这一段只做**记账**（删集合、取标记、消费静默队列），
// 没有网络副作用，所以可以单独测；而发送那半段要碰 deliverPrompt / sendToQQ，
// 混在一起就没法离线验证。
//
// 四个返回值都有用：
//   sendToolSucceeded —— 本轮是否已通过工具发过消息（决定要不要自动转发）
//   isFarewell        —— 本轮是否是"活跃超时退场"发言（决定退场后回不回观望）
//   silent            —— 本轮是否静默（摘要投喂），true 时调用方应直接 continue
//   cleaned           —— 清理了哪些集合（测试与日志用）

export function finalizeTurn({
  sessionId,
  social,
  v2TurnStartAt,
  collectors,
  turnLeaseNoted,
  sendToolSucceededSessions,
  pendingSendToolCalls,
  toolCallNames,
  silentTimeoutMs = 120000,
  now = Date.now()
} = {}) {
  const cleaned = [];

  v2TurnStartAt?.delete?.(sessionId); cleaned.push('v2TurnStartAt');
  collectors?.delete?.(sessionId); cleaned.push('collectors');
  turnLeaseNoted?.delete?.(sessionId); cleaned.push('turnLeaseNoted');

  const sendToolSucceeded = Boolean(sendToolSucceededSessions?.has?.(sessionId));
  sendToolSucceededSessions?.delete?.(sessionId); cleaned.push('sendToolSucceededSessions');
  pendingSendToolCalls?.delete?.(sessionId); cleaned.push('pendingSendToolCalls');
  toolCallNames?.delete?.(sessionId); cleaned.push('toolCallNames');

  // "活跃超时退场"标记：取完就清，避免把下一轮的普通回复误判成退场
  const isFarewell = Boolean(social?.exitingSessions?.has?.(sessionId));
  if (isFarewell) social.exitingSessions.delete(sessionId);

  // 摘要投喂回合：FIFO 时间戳队列 + 超时回收。
  // 为什么需要超时：万一某个静默回合没等到 turn/end，计数会残留并吞掉后续正常回复。
  const queue = social?.silentTurns?.get?.(sessionId) ?? [];
  let silent = false;
  if (queue.length) {
    while (queue.length && now - (queue[0]?.ts ?? 0) > silentTimeoutMs) queue.shift();
    if (queue.length) {
      silent = true;
      queue.shift();
      if (queue.length) social.silentTurns.set(sessionId, queue);
      else social.silentTurns.delete(sessionId);
    } else {
      // 全都被判为过期：把空队列也清掉，别留个空数组在那儿每轮都扫一遍
      social.silentTurns.delete(sessionId);
    }
  }

  return { sendToolSucceeded, isFarewell, silent, cleaned };
}