// pumpMux 的「工具调用追踪」：知道这一轮里 AI 到底有没有成功发过消息。
//
// 为什么单独一块：它是"要不要自动转发"的唯一依据 ——
//   工具调用成功 → 跳过自动转发（避免同一句话发两遍）
//   工具失败/没调 → 仍允许文本正常发出（不能因为工具挂了就不回话）
//
// 状态机很小但要精确：
//   tool/call   记下 callId → toolName（后面 tool/result 只有 callId）
//               若是"发送类工具"，把 callId 放进 pendingSendToolCalls
//   tool/result 按 callId 找回名字；发生在 pending 里且**没报错** → 标记"本轮已发送"
//   其它帧型    不处理（返回 false，交回主流程）

export function createMuxToolTracker(deps = {}) {
  const {
    toolCallNames, pendingSendToolCalls, sendToolSucceededSessions,
    isSendToolName, sanitizeToolArgs, appendToolLog
  } = deps;

  function handleCall(frame, key) {
    const toolName = String(frame.event?.data?.name ?? '');
    const callId = frame.event?.data?.callId;
    const args = sanitizeToolArgs?.(frame.event?.data?.arguments ?? frame.event?.data?.input ?? frame.event?.data?.args);
    appendToolLog?.({
      type: 'call',
      time: new Date().toISOString(),
      key,
      sessionId: frame.sessionId,
      tool: toolName,
      args
    });
    if (callId == null) return;
    if (isSendToolName?.(toolName)) {
      let pending = pendingSendToolCalls.get(frame.sessionId);
      if (!pending) { pending = new Set(); pendingSendToolCalls.set(frame.sessionId, pending); }
      pending.add(callId);
    }
    let nameMap = toolCallNames.get(frame.sessionId);
    if (!nameMap) { nameMap = new Map(); toolCallNames.set(frame.sessionId, nameMap); }
    nameMap.set(String(callId), toolName);
  }

  function handleResult(frame, key) {
    const callId = frame.event?.data?.message?.source?.callId;
    const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
    const resultBlock = frame.event?.data?.message?.content?.[0];
    const resultError = frame.event?.data?.message?.isError === true || resultBlock?.isError === true;
    const errorText = resultError
      ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event?.data?.message?.error ?? '').slice(0, 200)
      : '';
    appendToolLog?.({
      type: 'result',
      time: new Date().toISOString(),
      key,
      sessionId: frame.sessionId,
      tool: toolName,
      ok: !resultError,
      error: errorText ? sanitizeToolArgs?.(errorText) : null
    });
    if (callId == null) return;
    toolCallNames.get(frame.sessionId)?.delete(String(callId));
    const pending = pendingSendToolCalls.get(frame.sessionId);
    if (pending?.has(callId)) {
      pending.delete(callId);
      if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
      if (!resultError) sendToolSucceededSessions.add(frame.sessionId);
    }
  }

  /**
   * @returns {boolean} true = 这两类帧已被处理；false = 其它帧型（交回主流程）
   */
  function handleToolFrame(frame, key) {
    const type = frame?.event?.type;
    if (type === 'tool/call') { handleCall(frame, key); return true; }
    if (type === 'tool/result') { handleResult(frame, key); return true; }
    return false;
  }

  return { handleToolFrame };
}