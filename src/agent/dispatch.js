// 本地 agent 投递（0.5.46 · C3）
//
// 作用：把「收到消息 → 想 → 回」这条链，从"转发给 DSH"换成"自己在进程里跑完"。
// 触发条件：config.json 里 `agent.mode === "local"` 且有 apiKey。
//
// 为什么不直接改 deliverPromptNow：那条路径和 DSH 的会话/流式/工具高度耦合，
// 硬插分支会把两者都弄脏。这里只做一件事——**把 prompt 当用户消息，跑一轮本地 agent**，
// 工具负责把回复真的发出去（或由这里兜底发送）。
import fs from 'node:fs';
import path from 'node:path';
import { createProvider } from './provider.js';
import { createAgentLoop } from './loop.js';
import { createSocialTools } from './tools.js';
import { resolvePersona, composeSystemPrompt } from './persona.js';
import { resolveApiKey } from '../secret-box.js';
import { formatLongTerm } from '../memory-store.js';
import { getSharedRouter } from './brain-router.js';

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
  // P1：优先解密密文（apiKeyEnc），其次明文，最后环境变量
  const apiKey = resolveApiKey(a);
  // 自动模式：中继可达就走 PC 的 DSH（那边有本地工具与更强的模型），否则自己扛
  if (a.mode === 'auto' && typeof input.dshDeliver === 'function') {
    const router = getSharedRouter(cfg, { log });
    if (router.brain === 'dsh') {
      log('[agent] auto → DSH（中继可达）');
      await input.dshDeliver(key, promptText, {});
      return { ok: true, sent: true, steps: 0, reply: '', usage: {}, brain: 'dsh' };
    }
  }
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
  const persona = resolvePersona(cfg, { cwd: process.cwd(), maxChars: Number(a.personaMaxChars) || 3000 });
  // P2：长期记忆（跨重启存活的那一层）按相关度挑几条塞进提示——这是"不失忆"的关键
  const memoryBlock = readLongTermBlock(stateDir, key, promptText);
  const loop = createAgentLoop({
    provider,
    tools: wrapped,
    systemPrompt: composeSystemPrompt({
      persona: persona.text,
      keyLine,
      base: [memoryBlock, String(a.systemPrompt || DEFAULT_SYSTEM)].filter(Boolean).join('\n\n')
    }),
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

  log(`[agent] 本地回合完成 key=${key} steps=${r.steps} sent=${sent} 人格=${persona.source} 用时=${Date.now() - started}ms`);
  return { ok: true, sent, steps: r.steps, reply: r.reply, usage: r.usage, error: r.error };
}

/** 从 state/social-v2.json 里取该会话的长期记忆，按相关度挑几条 */
function readLongTermBlock(stateDir, key, query) {
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'social-v2.json'), 'utf8').replace(/^\uFEFF/, '');
    const st = JSON.parse(raw)?.conversations?.[key];
    const atoms = Array.isArray(st?.longTermMemories) ? st.longTermMemories : [];
    if (!atoms.length) return '';
    return formatLongTerm(atoms, { query: String(query || ''), limit: 8, maxChars: 800 });
  } catch { return ''; }
}
