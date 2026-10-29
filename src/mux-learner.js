// pumpMux 的「黑话学习会话」分支：这类会话只收集 turn 结果，**不发 QQ**。
//
// 为什么先搬这一段：
//   pumpMux 495 行、40+ 依赖，但这一块边界清楚（只碰 learner* 三个集合），
//   且有现成的护栏测试（scripts/test-mux-pump.mjs）。
//
// 两个"迟到事件"的坑（原文注释保留）：
//   · **只有 turn/start 才建 collector**。迟到事件（session/end-seed、session/title、
//     model/selection…）不会有 turn/end，若顺手建一个，它会永远留在 learnerCollectors
//     里并吞掉后续 turn 事件 —— 等待者要么拿不到结果，要么拿到错位的文本。
//   · turn 结束后要把旧学习会话从 learnerSessions 移除（当前那个除外），避免残留。

export function createLearnerFrameHandler(deps = {}) {
  const {
    learnerSessions, learnerCollectors, learnerWaiters,
    createTurnCollector, getSlangLearnerSessionId, clearTimeout: clearTimer
  } = deps;

  /**
   * @param {{sessionId:string, event:object}} frame
   * @returns {boolean} true = 已处理（调用方 continue）
   */
  function handleLearnerFrame(frame) {
    const sid = frame?.sessionId;
    if (!sid || !learnerSessions?.has?.(sid)) return false;

    let collector = learnerCollectors.get(sid) ?? null;
    if (!collector && frame.event?.type === 'turn/start') {
      collector = createTurnCollector();
      learnerCollectors.set(sid, collector);
    }
    const ended = collector ? collector.push(frame.event) : null;
    if (!ended) return true;   // 已消费（哪怕只是建了 collector）

    learnerCollectors.delete(sid);
    const waiters = learnerWaiters.get(sid) ?? [];
    const waiter = waiters.shift();
    if (waiters.length === 0) learnerWaiters.delete(sid);
    if (waiter) {
      clearTimer?.(waiter.timer);
      if (ended.reason?.kind === 'completed' && String(ended.text ?? '').trim()) {
        waiter.resolve(ended.text);
      } else {
        waiter.reject(new Error(`学习会话 turn 未正常完成：${ended.reason?.kind}`));
      }
    }
    // 旧学习会话 turn 结束后从集合移除，避免残留（当前那个留着）
    const current = typeof getSlangLearnerSessionId === 'function' ? getSlangLearnerSessionId() : null;
    if (sid !== current) learnerSessions.delete(sid);
    return true;
  }

  return { handleLearnerFrame };
}