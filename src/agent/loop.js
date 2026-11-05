// agent 循环（0.5.46 · C1）
//
// 目标：**没有 DSH 也能回答**。这一层只负责"来回几轮"，不关心模型是谁。
//
// 设计取舍：
//  · 工具调用在 C1 只做「执行 + 结果回填」的骨架，工具实现由 tools.js 注入（可空）
//  · 步数上限是硬闸：模型反复要工具时必须有终点，不能无限烧 token
//  · 任何异常都转成一段**人能读**的文本返回，绝不把 stack 丢给 QQ 用户
import { createUsageMeter } from './provider.js';
import { classifyError, publicMessage, recordError } from './error-code.js';

/**
 * @param {{
 *   provider: {textChat:Function, model?:string},
 *   tools?: Array<{name:string, description:string, parameters:object, run:Function}>,
 *   systemPrompt?: string,
 *   maxSteps?: number,
 *   maxTokens?: number,
 *   temperature?: number,
 *   log?: Function,
 *   meter?: object
 * }} opts
 */
export function createAgentLoop(opts = {}) {
  const {
    provider,
    tools = [],
    systemPrompt = '',
    maxSteps = 4,
    maxTokens = 2048,
    temperature = 0.8,
    log = () => {},
    meter = createUsageMeter(),
    // 自定义"这轮算成功了吗"判定：例如已经用工具把消息发出去，就不必再追问模型
    doneWhen = null
  } = opts;

  if (!provider || typeof provider.textChat !== 'function') {
    throw new Error('createAgentLoop 需要 provider.textChat');
  }

  const toolSpecs = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } }
  }));
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  /**
   * 跑一轮对话。
   * @param {{userText:string, history?:Array, signal?:AbortSignal}} input
   * @returns {Promise<{reply:string, steps:number, toolRuns:Array, usage:object, error?:string}>}
   */
  async function run(input = {}) {
    const { userText = '', history = [], signal } = input;
    const messages = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...history,
      { role: 'user', content: String(userText) }
    ];
    const toolRuns = [];
    let steps = 0;

    while (steps < maxSteps) {
      steps += 1;
      let resp;
      try {
        resp = await provider.textChat({ messages, tools: toolSpecs, maxTokens, temperature, signal });
      } catch (error) {
        const msg = String(error?.message ?? error);
        // 归类成错误码：群里只说人能懂的一句，完整信息写本地 state/diag
        const cls = classifyError(error);
        recordError(String(opts.stateDir || 'state'), cls, { where: 'model', key: String(input.key || '') });
        log(`[agent] 模型调用失败 ${cls.code}：${msg}`);
        return {
          reply: publicMessage(cls),
          steps, toolRuns, usage: meter.snapshot(), error: msg, busy: cls.code === 'E429', code: cls.code
        };
      }
      meter.add(resp.usage);

      if (!resp.toolCalls.length) {
        return { reply: resp.content, steps, toolRuns, usage: meter.snapshot() };
      }

      // 把助手的工具调用意图写回上下文，再逐个执行
      messages.push({ role: 'assistant', content: resp.content || '', tool_calls: resp.toolCalls });
      for (const call of resp.toolCalls) {
        const name = call?.function?.name || '';
        let args = {};
        try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { args = {}; }
        const tool = toolMap.get(name);
        let result;
        if (!tool) {
          result = { ok: false, error: `没有这个工具：${name}` };
        } else {
          try {
            result = await tool.run(args);
          } catch (error) {
            result = { ok: false, error: String(error?.message ?? error).slice(0, 300) };
          }
        }
        toolRuns.push({ name, args, ok: result?.ok !== false });
        messages.push({
          role: 'tool',
          tool_call_id: call.id || name,
          content: JSON.stringify(result).slice(0, 4000)
        });
      }
      // 工具跑完再看目标达成没有（比如消息已发出）：达成就不再多要一轮
      if (typeof doneWhen === 'function') {
        try {
          if (doneWhen({ steps, toolRuns, content: resp.content })) {
            return { reply: resp.content, steps, toolRuns, usage: meter.snapshot(), doneEarly: true };
          }
        } catch { /* 判定函数出错不影响主流程 */ }
      }
    }

    // 步数用完：不再问模型，直接把"没完成"讲清楚（比继续烧 token 好）
    log(`[agent] 达到步数上限 ${maxSteps}，停止`);
    return {
      reply: `（我绕了 ${maxSteps} 圈还没搞定，先停一下）`,
      steps,
      toolRuns,
      usage: meter.snapshot(),
      error: 'max-steps'
    };
  }

  return { run, tools: tools.map((t) => t.name), meter };
}
