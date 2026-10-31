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
  // 真机事故（2026-10-31 13:15）：不传模型时 agent 根本跑不起 turn ——
  // 会话建好了、followup 也入队了，但没有任何 assistant 事件，也不报错。
  // 宿主自己是这么建的：agentOptions={provider,model} + setup=installModelSelection(...)
  agentOptions = {},
  setup = undefined,
  // 宿主建 agent 时 meta 必带 cwd，并且会先把目录建出来（dsh-api-session-controller L511-525）。
  // 没有 cwd 的 agent 跑不起 turn —— 真机表现同样是"入队了但没反应"。
  cwdOf = null,
  fsForCwd = null,
  pathForCwd = null,
} = {}) {
  const sessions = new Map(); // chatKey -> { agent, dispose }

  async function ensure(chatKey) {
    if (sessions.has(chatKey)) return sessions.get(chatKey);
    const sessionId = sessionIdFor(chatKey);
    // 每个 QQ 会话一个工作目录（和桥接的 state/agents/<key> 保持一致的做法）
    let cwd;
    if (typeof cwdOf === 'function') {
      try {
        cwd = cwdOf(chatKey);
        if (cwd && fsForCwd) fsForCwd.mkdirSync(cwd, { recursive: true });
      } catch (e) {
        log(`创建会话工作目录失败（继续，但不一定有 cwd）：${e?.message ?? e}`);
        cwd = undefined;
      }
    }
    let handle;
    let actualSessionId = sessionId;
    try {
      handle = await agents.create({
        sessionId,
        meta: { ...meta, chatKey, ...(cwd ? { cwd } : {}) },
        agentOptions,
        setup,
      });
    } catch (e) {
      // 参考实现的经验：旧持久化会话占了同一 id 时会失败 → 换一个带时间戳的 id 重试一次
      const fallbackId = `${sessionId}#${Date.now().toString(36)}`;
      actualSessionId = fallbackId;
      log(`agent create 失败（${e?.message ?? e}），换 id 重试：${fallbackId}`);
      handle = await agents.create({
        sessionId: fallbackId,
        meta: { ...meta, chatKey, ...(cwd ? { cwd } : {}) },
        agentOptions,
        setup,
      });
    }
    // ⚠️ 真机事故（2026-10-31 13:11）：新建的 agent 从没开始跑过，`whenIdle()` 可能
    // **永不 resolve** —— `await` 就永远卡在 followup 之前：会话建好了、消息没进去、
    // 也不报错（全靠 plugin.log 才发现）。这里给 1.5s 上限，等不到就继续。
    if (typeof handle.agent?.whenIdle === 'function') {
      try {
        await Promise.race([
          Promise.resolve(handle.agent.whenIdle()),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      } catch (e) {
        log(`whenIdle 失败（${e?.message ?? e}）；继续`);
      }
    }
    const entry = { agent: handle.agent, dispose: handle.dispose, sessionId: actualSessionId };
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
    // followup 是**同步入队**（agent-loop: send(input,'next-turn',true)），
    // 不要等它返回什么；入队后由 agent loop 自己去开 turn。
    entry.agent.followup(createUserMessage(msg));
    log(`已入队 → session=${entry.sessionId ?? '?'} 文本长度=${String(text).length}`);
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