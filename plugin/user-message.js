/**
 * 把一条 QQ 文本包成 DSH 的 user message。
 *
 * 形状依据（@deepseek-ai/dsh-llm 0.0.1-rc.1，lib/types/message.d.ts L131-174）：
 *   UserMessage   = { id, role: 'user', content: ContentBlock[], source: MessageSource }
 *   NewUserMessage = Omit<UserMessage, 'id' | 'role'>  → 只给 { content, source }
 *   createUserMessage(input) 会拒绝 id/role（TS 层 `readonly id?: never`），并自己铸造 id
 *
 * ContentBlock（types.d.ts L25-71）：
 *   { type: 'text', text } | { type: 'reasoning', text } | { type: 'image', attachment }
 *   | { type: 'tool-call', ... } | { type: 'tool-result', ... }
 *
 * MessageSourceMap（message.d.ts L94-100）里 user 的形状就是 `{ kind: 'user' }`。
 *
 * 为什么要自己拼而不是直接调 createUserMessage：
 *   插件在离线测试/宿主版本不匹配时也要能构造消息（不能因为一个 peer 依赖就整段不可用），
 *   所以这里只产出**纯数据**，真正调用 createUserMessage 的地方再做一次形状校验。
 */

/** 纯数据：一条 QQ 文本 → NewUserMessage 形状（不含 id/role）。 */
export function buildUserMessage(text, { source = { kind: 'user' } } = {}) {
  const body = String(text ?? '');
  return {
    content: [{ type: 'text', text: body }],
    source: { ...source },
  };
}

/** 结构校验：给"调用 createUserMessage 之前"用，失败信息要能直接定位问题。 */
export function assertNewUserMessage(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('user message 必须是对象');
  if (msg.id !== undefined) throw new Error('user message 不能带 id（createUserMessage 自己铸造）');
  if (msg.role !== undefined) throw new Error('user message 不能带 role（由 createUserMessage 固定为 user）');
  if (!Array.isArray(msg.content) || msg.content.length === 0) throw new Error('content 必须是非空数组');
  for (const [i, block] of msg.content.entries()) {
    if (!block || typeof block !== 'object') throw new Error(`content[${i}] 必须是对象`);
    if (typeof block.type !== 'string') throw new Error(`content[${i}].type 缺失`);
    if (block.type === 'text' && typeof block.text !== 'string') throw new Error(`content[${i}].text 必须是字符串`);
  }
  if (!msg.source || typeof msg.source !== 'object') throw new Error('source 必须是对象');
  if (msg.source.kind !== 'user') throw new Error(`source.kind 必须是 'user'，实际 ${String(msg.source.kind)}`);
  return true;
}