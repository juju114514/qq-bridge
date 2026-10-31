/**
 * 插件内的 QQ 工具（N1 第一批：发送 / 引用回复 / 标记已读）。
 *
 * 与 MCP 版本的区别：这些是**进程内**工具，直接拿得到 channel 与 sidecar，
 * 少一次 stdio 往返，也少一个进程。参数校验写在这里，错误信息要能让模型自己纠正。
 *
 * 工具约定（真机验证过）：
 *   · output 必须同时有 schema 和 render
 *   · schema.type 只能是 object/array/string/number/integer/boolean/null
 */

const CHAT_ID_PATTERN = /^(group|private):\d+$/;

export function parseChatId(value) {
  const s = String(value ?? '').trim();
  if (!CHAT_ID_PATTERN.test(s)) return null;
  const [kind, id] = s.split(':');
  return { kind, id: Number(id), key: s };
}

/** 统一的工具输出描述：文本渲染 + 宽松的 object schema。 */
const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => {
    const v = value && typeof value === 'object' ? value : {};
    const text = typeof v.message === 'string' && v.message
      ? v.message
      : (v.ok === false ? '失败' : '完成');
    return [{ type: 'text', text: v.ok === false ? `失败：${text}` : text }];
  },
};

export function createTools({ channel, sidecar = null, chatLog = null, log = () => {} } = {}) {
  const tools = [];

  // ── qq_send_message ─────────────────────────────────────────────
  tools.push({
    name: 'qqb_send_message',
    description: '向指定的 QQ 群或私聊发送一条纯文本消息。chat_id 形如 group:<群号> 或 private:<QQ号>。',
    parameters: {
      chat_id: { type: 'string', required: true, description: '目标会话：group:<群号> 或 private:<QQ号>' },
      text: { type: 'string', required: true, description: '要发送的纯文本（不要 Markdown、不要 CQ 码）' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const chat = parseChatId(args?.chat_id);
      if (!chat) return { ok: false, message: 'chat_id 格式不对，应为 group:<群号> 或 private:<QQ号>' };
      const text = String(args?.text ?? '');
      if (!text.trim()) return { ok: false, message: 'text 不能为空' };
      if (!channel) return { ok: false, message: '通道未启动（插件未 enabled 或 OneBot 未连接）' };
      try {
        const res = await channel.send(chat.key, text);
        return { ok: true, message: `已发送到 ${chat.key}`, messageId: res?.data?.message_id ?? null };
      } catch (e) {
        log('qq_send_message 失败：' + (e?.message ?? e));
        return { ok: false, message: '发送失败：' + (e?.message ?? e) };
      }
    },
  });

  // ── qq_reply ────────────────────────────────────────────────────
  tools.push({
    name: 'qqb_reply',
    description: '引用某条 QQ 消息并回复。适合群里消息很多、需要明确“我在回哪一条”时用。',
    parameters: {
      chat_id: { type: 'string', required: true, description: '目标会话：group:<群号> 或 private:<QQ号>' },
      message_id: { type: 'string', required: true, description: '被引用消息的 id（可为负数）' },
      text: { type: 'string', required: true, description: '回复的纯文本' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const chat = parseChatId(args?.chat_id);
      if (!chat) return { ok: false, message: 'chat_id 格式不对' };
      const mid = String(args?.message_id ?? '').trim();
      if (!mid) return { ok: false, message: 'message_id 不能为空' };
      const text = String(args?.text ?? '');
      if (!text.trim()) return { ok: false, message: 'text 不能为空' };
      if (!channel) return { ok: false, message: '通道未启动' };
      const action = chat.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
      const idField = chat.kind === 'group' ? 'group_id' : 'user_id';
      try {
        const res = await channel.call(action, {
          [idField]: chat.id,
          message: [
            { type: 'reply', data: { id: mid } },
            { type: 'text', data: { text } },
          ],
        });
        return { ok: true, message: `已回复（引用 ${mid}）`, messageId: res?.data?.message_id ?? null };
      } catch (e) {
        log('qq_reply 失败：' + (e?.message ?? e));
        return { ok: false, message: '回复失败：' + (e?.message ?? e) };
      }
    },
  });

  // ── qq_get_recent_messages / qq_get_unread_messages ──────────────
  const readLog = (args, { onlyUnread = false } = {}) => {
    const chat = parseChatId(args?.chat_id);
    if (!chat) return { error: 'chat_id 格式不对' };
    if (!chatLog) return { error: '会话缓冲不可用（插件刚启动或未启用通道）', degraded: true };
    const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
    const list = onlyUnread ? chatLog.unread(chat.key) : chatLog.recent(chat.key, { limit });
    return {
      chat,
      list: (onlyUnread ? list.slice(-limit) : list).map((e) => ({
        seq: e.seq, at: e.at, userId: e.userId, text: e.text, self: e.self,
      })),
      stats: chatLog.stats(chat.key),
    };
  };

  tools.push({
    name: 'qqb_get_recent_messages',
    description: '取某个会话最近的聊天记录（含自己发的，最多 50 条）。注意：只有机器人上线之后的消息，历史不会回补。',
    parameters: {
      chat_id: { type: 'string', required: true, description: '目标会话：group:<群号> 或 private:<QQ号>' },
      limit: { type: 'number', description: '取多少条，默认 20，最多 50' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const r = readLog(args);
      if (r.error) return { ok: false, degraded: !!r.degraded, message: r.error };
      return { ok: true, message: `最近 ${r.list.length} 条`, messages: r.list, stats: r.stats };
    },
  });

  tools.push({
    name: 'qqb_get_unread_messages',
    description: '取上次 mark_read 之后的新消息（别人说的，不含自己发的）。开口之前先看这个，避免重复回应。',
    parameters: {
      chat_id: { type: 'string', required: true, description: '目标会话：group:<群号> 或 private:<QQ号>' },
      limit: { type: 'number', description: '最多取多少条，默认 20' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const r = readLog(args, { onlyUnread: true });
      if (r.error) return { ok: false, degraded: !!r.degraded, message: r.error };
      return { ok: true, message: `${r.list.length} 条未读`, messages: r.list, stats: r.stats };
    },
  });

  // ── qq_wait_for_messages ────────────────────────────────────────
  tools.push({
    name: 'qqb_wait_for_messages',
    description: '等一条新消息（最长 60 秒）。想潜水但不想错过接话时用；超时会正常返回 timeout，不是错误。',
    parameters: {
      chat_id: { type: 'string', required: true, description: '目标会话：group:<群号> 或 private:<QQ号>' },
      timeout_ms: { type: 'number', description: '等多久，默认 30000，最大 60000' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const chat = parseChatId(args?.chat_id);
      if (!chat) return { ok: false, message: 'chat_id 格式不对' };
      if (!chatLog) return { ok: false, degraded: true, message: '会话缓冲不可用' };
      const timeoutMs = Math.min(60_000, Math.max(1_000, Number(args?.timeout_ms) || 30_000));
      const r = await chatLog.waitFor(chat.key, { timeoutMs });
      if (!r.ok) return { ok: true, reason: 'timeout', message: `${Math.round(timeoutMs / 1000)} 秒内没有新消息` };
      return { ok: true, message: '来新消息了', message_: r.entry, seq: r.entry.seq, text: r.entry.text, userId: r.entry.userId };
    },
  });

  // ── qq_get_prompt ───────────────────────────────────────────────
  tools.push({
    name: 'qqb_get_prompt',
    description: '取当前会话的提示词快照：人格卡、人物印象、群记忆交接、最近消息、唤醒配置。每次开口前先看一眼，能避免"人设漂移"和"忘了昨天聊过什么"。',
    parameters: {
      chat_id: { type: 'string', required: true, description: '目标会话：group:<群号> 或 private:<QQ号>' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const chat = parseChatId(args?.chat_id);
      if (!chat) return { ok: false, message: 'chat_id 格式不对' };
      if (!sidecar?.snapshot) {
        return { ok: false, degraded: true, message: 'sidecar 未连接：拿不到人格卡与群记忆（仍可正常收发消息）' };
      }
      try {
        const snap = await sidecar.snapshot(chat.key);
        if (!snap.ok) return { ok: false, degraded: true, message: '快照获取失败：' + (snap.error ?? snap.status) };
        const st = snap.state ?? {};
        const memoryText = String(st.memory?.text ?? '').trim();
        return {
          ok: true,
          message: snap.notModified ? '快照未变化（缓存命中）' : '快照已更新',
          notModified: !!snap.notModified,
          role: st.role ?? null,
          people: st.people ?? null,
          wake: st.wake ?? null,
          handoff: memoryText || '（这个会话还没有交接记录）',
          recent: Array.isArray(st.recent) ? st.recent.slice(-10) : [],
        };
      } catch (e) {
        log('qq_get_prompt 失败：' + (e?.message ?? e));
        return { ok: false, degraded: true, message: '快照获取异常：' + (e?.message ?? e) };
      }
    },
  });

  // ── qq_mark_read ────────────────────────────────────────────────
  tools.push({
    name: 'qqb_mark_read',
    description: '把某个会话“读到指定水位”，避免下次唤醒重复处理同一条消息。依赖 sidecar；sidecar 不在时返回 degraded 而不是报错。',
    parameters: {
      chat_id: { type: 'string', required: true, description: '目标会话：group:<群号> 或 private:<QQ号>' },
      through_seq: { type: 'number', description: '已读水位（省略则读到最新）' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const chat = parseChatId(args?.chat_id);
      if (!chat) return { ok: false, message: 'chat_id 格式不对' };
      if (!sidecar?.postIntent) {
        const through = Number(args?.through_seq ?? 0) || 0;
        if (chatLog) chatLog.markRead(chat.key, through || undefined);
        return { ok: false, degraded: true, message: 'sidecar 未连接：已读水位只记在内存（重启会丢）' };
      }
      try {
        const through = Number(args?.through_seq ?? 0) || 0;
        if (chatLog) chatLog.markRead(chat.key, through || undefined);
        await sidecar.postIntent({
          key: chat.key,
          intent: 'read.mark',
          payload: { throughSeq: through },
        });
        return { ok: true, message: `已标记已读：${chat.key}` };
      } catch (e) {
        log('qq_mark_read 失败：' + (e?.message ?? e));
        return { ok: false, degraded: true, message: 'sidecar 调用失败：' + (e?.message ?? e) };
      }
    },
  });

  return tools;
}