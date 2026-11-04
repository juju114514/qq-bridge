// 模型调用层（0.5.46 · C1）
//
// 为什么要自己写这一层：桥接现在把「思考」外包给 DSH（Electron 桌面应用），
// 手机能跑桥接、能跑网关，但没有 DSH 就一句话也答不出来。
// AstrBot 的手机独立靠的就是「框架自带 agent + 直接 HTTP 调模型」——这一层复刻那个思路，
// 代码自己写，不引入 SDK。
//
// 只做一件事：把 messages（+ 可选 tools）发出去，把回复拿回来。
// 不做重试风暴、不做多 provider 抽象 —— 那些等真需要时再说。

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

/** 这些状态码值得重试：限流 / 上游过载 / 网关错误 */
export const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把上游的英文繁忙文案翻成人话（同时打上 code，供上层识别） */
function normalizeUpstreamError(status, body) {
  const text = String(body || '');
  if (/too busy|overload|rate limit|temporarily unavailable/i.test(text) || status === 503) {
    const e = new Error(`模型服务正忙（上游 ${status || '过载'}），请稍后重试`);
    e.code = 'MODEL_BUSY';
    e.status = status;
    return e;
  }
  if (status === 429) {
    const e = new Error('模型服务限流了，请稍后重试');
    e.code = 'MODEL_BUSY';
    e.status = status;
    return e;
  }
  const e = new Error(`模型接口 HTTP ${status}：${text.slice(0, 300)}`);
  e.status = status;
  return e;
}


/** token 用量累加器（跨多轮） */
export function createUsageMeter() {
  const total = { prompt: 0, completion: 0, cached: 0, calls: 0 };
  return {
    add(usage) {
      if (!usage) return;
      total.prompt += Number(usage.prompt_tokens) || 0;
      total.completion += Number(usage.completion_tokens) || 0;
      total.cached += Number(usage.prompt_cache_hit_tokens) || 0;
      total.calls += 1;
    },
    snapshot: () => ({ ...total })
  };
}

/**
 * @param {{baseUrl?:string, apiKey:string, model?:string, timeoutMs?:number, fetchImpl?:Function}} opts
 */
export function createProvider(opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    apiKey = '',
    model = DEFAULT_MODEL,
    timeoutMs = 120000,
    fetchImpl = (...a) => fetch(...a)
  } = opts;

  if (!apiKey) throw new Error('创建 provider 需要 apiKey');

  /**
   * @param {{messages:Array, tools?:Array, temperature?:number, maxTokens?:number, signal?:AbortSignal}} req
   * @returns {Promise<{content:string, toolCalls:Array, usage:object|null, finishReason:string}>}
   */
  async function textChat(req = {}) {
    const { messages = [], tools = [], temperature = 0.8, maxTokens = 2048, signal } = req;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('textChat 需要至少一条 message');
    }
    const body = { model, messages, temperature, max_tokens: maxTokens };
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
    // 退避重试：429/5xx 与网络抖动都值得再试，最多 3 次（1s → 3s → 8s）
    const delays = [1000, 3000, 8000];
    let res = null;
    let lastError = null;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: signal || AbortSignal.timeout(timeoutMs)
        });
        if (res.ok || !RETRIABLE_STATUS.has(res.status)) break;
        lastError = normalizeUpstreamError(res.status, await res.text().catch(() => ''));
      } catch (error) {
        // fetch 抛错（DNS/连接被重置/超时）也可以重试
        lastError = error;
        res = null;
      }
      if (attempt < delays.length) {
        const jitter = Math.floor(Math.random() * 400);
        await sleep(delays[attempt] + jitter);
      }
    }

    if (!res) throw lastError || new Error('模型请求失败');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw normalizeUpstreamError(res.status, text);
    }
    const json = await res.json();
    const choice = json?.choices?.[0];
    if (!choice) throw new Error('模型接口没有返回 choices');
    const msg = choice.message || {};
    return {
      content: String(msg.content || ''),
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
      usage: json.usage || null,
      finishReason: String(choice.finish_reason || '')
    };
  }

  return { textChat, model, baseUrl };
}
