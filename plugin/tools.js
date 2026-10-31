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

export function createTools({ channel, sidecar = null, log = () => {} } = {}) {
  const tools = [];

  // ── qq_send_message ─────────────────────────────────────────────
  tools.push({
    name: 'qq_send_message',
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
    name: 'qq_reply',
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

  // ── qq_mark_read ────────────────────────────────────────────────
  tools.push({
    name: 'qq_mark_read',
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
        return { ok: false, degraded: true, message: 'sidecar 未连接：已读水位没有落库（被动回复仍可用）' };
      }
      try {
        await sidecar.postIntent({
          key: chat.key,
          intent: 'read.mark',
          payload: { throughSeq: Number(args?.through_seq ?? 0) || 0 },
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