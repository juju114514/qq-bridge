// 进线管道的"社交阶段"（reserved2）—— 波次 3 第二块。
//
// 这一段决定**一条消息进到二代仿真里之后发生什么**：
//   1. 记进会话（recentMessages 滚动窗口）
//   2. 群聊喂黑话学习窗口
//   3. AI 暂停 → 只入库不唤醒
//   4. 首次消息 → bootstrap 唤醒（带人设介绍）
//   5. 否则按触发器判定 → 命中才唤醒
//
// 顺序有意义：**先入库再判定**。否则"没唤醒"的消息会完全丢失，
// AI 醒来后看不到这段时间群里说了什么（这正是 unread 存在的理由）。

/**
 * @returns {{ handled: boolean, action: 'paused'|'bootstrap'|'wake'|'unread', reason?: string }}
 */
export function runSocialIncomingStage(ctx, deps) {
  const {
    key, kind, event, textContent, plainContent, quoteTargetIsSelf, isOwner, traceRec
  } = ctx;
  const {
    paused = false,
    getState,
    saveState = () => {},
    appendMessage,
    feedSlang = () => {},
    scheduleWake,
    evaluateTrigger,
    appendActivity = () => {},
    trace = { step() {}, finish() {} }
  } = deps;

  const sender = kind === 'group'
    ? (event?.sender?.card || event?.sender?.nickname || String(event?.user_id ?? ''))
    : '';
  appendMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event?.message_id ?? event?.messageId);
  // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
  if (kind === 'group') feedSlang(key, sender, plainContent);

  if (paused) {
    appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${String(textContent).slice(0, 80)}`);
    trace.step(traceRec, '唤醒', '已暂停');
    trace.finish(traceRec, 'AI 已暂停，消息只入库');
    return { handled: true, action: 'paused' };
  }

  const st = getState(key);
  if (!st.bootstrapSent) {
    st.bootstrapSent = true;
    saveState();
    scheduleWake(key, 'bootstrap');
    appendActivity(`${key} [reserved2] 消息已入未读：${String(textContent).slice(0, 80)}`);
    return { handled: true, action: 'bootstrap', reason: 'bootstrap' };
  }

  // 判定的返回值是**对象**（{ reason, redPacket? }）：红包这种"带数据的原因"要能传下去
  const verdict = evaluateTrigger(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
  const reason = verdict?.reason ?? null;
  trace.step(traceRec, '唤醒', reason ? '命中' : '未命中', reason ? String(reason) : '概率/条件未满足');
  trace.finish(traceRec, reason ? `已唤醒（${reason}），稍后进模型` : '已入未读，未唤醒');
  if (reason) scheduleWake(key, reason);

  appendActivity(`${key} [reserved2] 消息已入未读：${String(textContent).slice(0, 80)}`);
  return { handled: true, action: reason ? 'wake' : 'unread', reason: reason ?? undefined };
}