// agent 路由（0.5.46 · C1）
//
// 这是 C1 的**验证入口**：不经过 DSH，直接让桥接用自带的 provider 回答一句话。
// 等 C2/C3 把工具和人格接上之后，正式的消息处理路径会改走同一套 loop。
import { createProvider } from '../agent/provider.js';
import { resolveApiKey } from '../secret-box.js';
import { createAgentLoop } from '../agent/loop.js';
import { createSocialTools } from '../agent/tools.js';

/** 从 config 里读 agent 段；缺 key 时返回 null（调用方给可读错误） */
function resolveAgentConfig(cfg = {}, env = process.env) {
  const a = cfg.agent || {};
  const apiKey = resolveApiKey(a, { env });
  return {
    enabled: a.enabled !== false,
    apiKey,
    baseUrl: String(a.baseUrl || 'https://api.deepseek.com'),
    model: String(a.model || 'deepseek-chat'),
    systemPrompt: String(a.systemPrompt || '你是一个中文聊天助手，回答简短自然，不超过 120 字。'),
    maxSteps: Number(a.maxSteps) || 2,
    temperature: Number.isFinite(a.temperature) ? a.temperature : 0.8
  };
}

export async function handleAgentRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || url.pathname !== '/api/agent/chat') return false;
  if (req.method !== 'POST') { sendJson({ ok: false, error: '只支持 POST' }, 405); return true; }

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  let cfg = {};
  try { cfg = typeof d.getCfg === 'function' ? (d.getCfg() || {}) : {}; } catch { cfg = {}; }
  const ac = resolveAgentConfig(cfg);
  if (!ac.enabled) { sendJson({ ok: false, error: 'agent 已在配置里关闭（agent.enabled=false）' }, 400); return true; }
  if (!ac.apiKey) {
    sendJson({ ok: false, error: '没有 API key：在 config.json 的 agent.apiKey 填，或设环境变量 DEEPSEEK_API_KEY' }, 400);
    return true;
  }

  const body = typeof ctx.readBody === 'function' ? await ctx.readBody() : {};
  const text = String(body?.text || '').trim();
  if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return true; }

  const started = Date.now();
  const wantTools = body?.tools !== false && Boolean(body?.key);
  try {
    const provider = createProvider({ baseUrl: ac.baseUrl, apiKey: ac.apiKey, model: ac.model });
    // C2：把桥接自己的能力包成工具交给模型（key 决定"发到哪个会话"）
    const tools = wantTools
      ? createSocialTools({
        stateDir: d.stateDir || 'state',
        sendToQQ: d.sendToQQ,
        log: (m) => { try { d.log?.(m); } catch { /* ignore */ } }
      })
      : [];
    const systemPrompt = wantTools
      ? `${ac.systemPrompt}\n\n你可以用工具查看当前会话（key=${String(body.key)}）的消息与记忆，并用 qq_send_message 回复。发消息前先 qq_get_context 看上下文，别重复别人刚说过的话。`
      : ac.systemPrompt;
    const loop = createAgentLoop({ provider, tools, systemPrompt, maxSteps: ac.maxSteps, temperature: ac.temperature });
    const r = await loop.run({ userText: text });
    sendJson({
      ok: !r.error,
      at: Date.now(),
      model: ac.model,
      reply: r.reply,
      steps: r.steps,
      toolRuns: r.toolRuns,
      usage: r.usage,
      durationMs: Date.now() - started,
      error: r.error || undefined
    });
  } catch (error) {
    sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 300) }, 500);
  }
  return true;
}
