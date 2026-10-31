/**
 * Agent 驱动：把"一个 QQ 会话"映射到"一个 DSH Agent 会话"。
 *
 * 依据 docs/design/dsh-plugin-api-notes.md 第 4 节的实测结论：
 *   ctx.agents.create({ sessionId, meta, agentOptions, setup }) → { agent, dispose }
 *   await agent.whenIdle()                    // create 之后先等初始化
 *   agent.followup(createUserMessage({...}))   // 喂一条用户消息
 *
 * 本模块不直接 import @deepseek-ai/dsh-llm：宿主版本不匹配时，
 * 至少还能构造消息并给出可读错误（而不是整个插件挂不上）。
 */

import { buildUserMessage, assertNewUserMessage } from './user-message.js';

export function sessionIdFor(chatKey) {
  // 稳定 id：同一个群/私聊永远同一个会话（重启后 DSH 自己按 id 恢复历史）
  return 'qqbridge:' + String(chatKey).replace(/[^a-zA-Z0-9:_-]/g, '_');
}

export function createAgentDriver({
  agents,
  loadCreateUserMessage,
  log = () => {},
  meta = {},
} = {}) {
  const sessions = new Map(); // chatKey -> { agent, dispose }

  async function ensure(chatKey) {
    if (sessions.has(chatKey)) return sessions.get(chatKey);
    const sessionId = sessionIdFor(chatKey);
    let handle;
    try {
      handle = await agents.create({
        sessionId,
        meta: { ...meta, chatKey },
        agentOptions: {},
        setup: undefined,
      });
    } catch (e) {
      // 参考实现的经验：旧持久化会话占了同一 id 时会失败 → 换一个带时间戳的 id 重试一次
      const fallbackId = `${sessionId}#${Date.now().toString(36)}`;
      log(`agent create 失败（${e?.message ?? e}），换 id 重试：${fallbackId}`);
      handle = await agents.create({
        sessionId: fallbackId,
        meta: { ...meta, chatKey },
        agentOptions: {},
        setup: undefined,
      });
    }
    try {
      if (typeof handle.agent?.whenIdle === 'function') await handle.agent.whenIdle();
    } catch (e) {
      log(`whenIdle 失败（${e?.message ?? e}）；继续，但首轮可能排队`);
    }
    const entry = { agent: handle.agent, dispose: handle.dispose };
    sessions.set(chatKey, entry);
    return entry;
  }

  async function deliver(chatKey, text) {
    const entry = await ensure(chatKey);
    const msg = buildUserMessage(text);
    assertNewUserMessage(msg);
    let createUserMessage = null;
    try {
      createUserMessage = await loadCreateUserMessage();
    } catch (e) {
      throw new Error('无法加载 @deepseek-ai/dsh-llm 的 createUserMessage：' + (e?.message ?? e));
    }
    if (typeof entry.agent?.followup !== 'function') {
      throw new Error('agent.followup 不可用（DSH 版本不匹配？）');
    }
    await entry.agent.followup(createUserMessage(msg));
    return entry;
  }

  async function disposeAll() {
    for (const [key, entry] of sessions) {
      sessions.delete(key);
      try { await entry.dispose?.(); } catch { /* 卸载失败不影响其它 */ }
    }
  }

  return { ensure, deliver, disposeAll, sessions };
}