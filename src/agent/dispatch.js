// 本地 agent 投递（0.5.46 · C3）
//
// 作用：把「收到消息 → 想 → 回」这条链，从"转发给 DSH"换成"自己在进程里跑完"。
// 触发条件：config.json 里 `agent.mode === "local"` 且有 apiKey。
//
// 为什么不直接改 deliverPromptNow：那条路径和 DSH 的会话/流式/工具高度耦合，
// 硬插分支会把两者都弄脏。这里只做一件事——**把 prompt 当用户消息，跑一轮本地 agent**，
// 工具负责把回复真的发出去（或由这里兜底发送）。
import { createProvider } from './provider.js';
import { createAgentLoop } from './loop.js';
import { createSocialTools } from './tools.js';

const DEFAULT_SYSTEM = '你是一个在 QQ 群里聊天的中文助手。根据给定的上下文和当前消息，写一条自然、简短、像本人的回复（不超过 80 字）。'
  + '需要看更多上下文就调用工具；要开口说话就用 qq_send_message 工具发出去，不要只把回复写在正文里。';

/**
 * @param {{
 *   cfg: object, key: string, promptText: string,
 *   sendToQQ?: Function, stateDir?: string, log?: Function
 * }} input
 * @returns {Promise<{ok:boolean, sent:boolean, steps:number, reply:string, usage:object, error?:string}>}
 */
export async function runLocalAgentTurn(input = {}) {
  const { cfg = {}, key = '', promptText = '', sendToQQ = null, stateDir = 'state', log = () => {} } = input;
  const a = cfg.agent || {};
  const apiKey = String(a.apiKey || process.env.DEEPSEEK_API_KEY || '');
  if (!apiKey) return { ok: false, sent: false, steps: 0, reply: '', usage: {}, error: '没有 apiKey' };
  if (!key || !promptText) return { ok: false, sent: false, steps: 0, reply: '', usage: {}, error: '缺 key 或 promptText' };

  const provider = createProvider({
    baseUrl: String(a.baseUrl || 'https://api.deepseek.com'),
    apiKey,
    model: String(a.model || 'deepseek-chat')
  });
  const tools = createSocialTools({
    stateDir,
    sendToQQ,
    log,
    // 只给"当前会话"的写权限：模型想发给别人得自己拼 key，会撞白名单正则
    defaultKey: key
  });

  let sent = false;
  const wrapped = tools.map((t) => (t.name === 'qq_send_message'
    ? { ...t, run: async (args) => { const r = await t.run(args); if (r?.ok) sent = true; return r; } }
    : t));

  // 把「当前会话 key」写进系统提示的最前面：模型常常忽略后面那句，导致反问"发到哪个会话"
  const keyLine = `当前会话 key = ${key}。调用 qq_send_message 时用这个 key（省略也默认发给它），不要再问用户在哪个会话。`;
  const loop = createAgentLoop({
    provider,
    tools: wrapped,
    systemPrompt: `${keyLine}\n\n${String(a.systemPrompt || DEFAULT_SYSTEM)}`,
    // 有工具时至少给两轮：一轮看上下文，一轮发消息
    maxSteps: Number(a.maxSteps) || 4,
    temperature: Number.isFinite(Number(a.temperature)) ? Number(a.temperature) : 0.8,
    log,
    // 关键：只要这一轮真的发出去过消息，就算完成，不再追问模型
    doneWhen: () => sent
  });

  const started = Date.now();
  const r = await loop.run({ userText: promptText });

  // 兜底：模型只写了正文没调工具 → 由这里发出去（用户不该看到"没反应"）
  if (!sent && r.reply && !r.error) {
    try {
      await sendToQQ(key, String(r.reply).slice(0, 1500));
      sent = true;
      log(`[agent] 模型没调工具，已代发 ${String(r.reply).length} 字 → ${key}`);
    } catch (error) {
      log(`[agent] 代发失败：${error?.message ?? error}`);
    }
  }

  log(`[agent] 本地回合完成 key=${key} steps=${r.steps} sent=${sent} 用时=${Date.now() - started}ms`);
  return { ok: true, sent, steps: r.steps, reply: r.reply, usage: r.usage, error: r.error };
}
