/**
 * 人格卡「联网草稿」：输入名字 + 偏好 → 联网搜资料 → 生成一张可编辑的角色卡草稿。
 *
 * 为什么单独一个模块：这是「新建人格卡」的辅助流程，既不该塞进 bridge.js（体积闸门），
 * 也不该和 roles.js 的 CRUD 混在一起（它要联网、要调模型，失败面完全不同）。
 *
 * 设计取舍：
 *   · 搜索用仓库已有的 web-search.js（provider/key 走 config.webSearch），不引第三方 SDK
 *   · 「总结」这一步优先用本机模型（Ollama，可选）；没有模型时退化成**结构化模板 + 资料摘录**，
 *     仍然比空白卡片有用，且不会假装"AI 写好了"
 *   · 永远返回 sources（标题 + 链接），方便人核对有没有编造设定
 *
 * 返回：
 *   { ok, name, markdown, sources: [{title,url}], ai: boolean, aiModel?: string, warning?: string }
 */

import { webSearch } from './web-search.js';

const SECTION_ORDER = ['身份', '性格与语气', '说话习惯', '喜欢与讨厌', '边界', '示例对话', '参考资料'];

/** 把搜索结果压成「一行一条」的摘录，避免把整页文本塞进卡片。 */
export function formatSources(results = [], limit = 6) {
  return (Array.isArray(results) ? results : [])
    .slice(0, limit)
    .map((r) => {
      const title = String(r?.title ?? '').trim() || '(无标题)';
      const url = String(r?.url ?? '').trim();
      const snippet = String(r?.snippet ?? r?.description ?? '').replace(/\s+/g, ' ').trim();
      return { title, url, snippet: snippet.slice(0, 160) };
    });
}

/** 有没有可用的本机模型（Ollama）。失败静默，不阻塞草稿生成。 */
export async function probeLocalModel({ baseUrl = 'http://127.0.0.1:11434', timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/api/tags', {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false };
    const data = await res.json().catch(() => ({}));
    const models = (data.models || []).map((m) => String(m.name || '')).filter(Boolean);
    if (!models.length) return { ok: false };
    // 优先小模型/中文强的；没有偏好就用第一个
    const preferred = models.find((m) => /qwen|glm|deepseek|llama/i.test(m)) || models[0];
    return { ok: true, model: preferred, models, baseUrl };
  } catch {
    return { ok: false };
  }
}

async function askLocalModel({ baseUrl, model, prompt, timeoutMs = 180000 }) {
  const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.7, num_predict: 420 }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`模型返回 ${res.status}`);
  const data = await res.json();
  return String(data.response || '').trim();
}

/** 结构化模板（没有模型时的兜底，也用作模型输出的骨架参考）。 */
export function buildTemplate({ name, hints, sources }) {
  const hintLine = String(hints || '').trim();
  const srcLines = sources.length
    ? sources.map((s) => `- ${s.title}${s.url ? ` <${s.url}>` : ''}${s.snippet ? `：${s.snippet}` : ''}`).join('\n')
    : '- （没搜到资料，按你给的偏好写）';

  return `## 身份
你是「${name}」。${hintLine ? `对方给的设定线索：${hintLine}。` : ''}
（把这里补成一句完整的人设：你是谁、从哪来、和对方是什么关系。）

## 性格与语气
- 核心性格：（从上面的线索里提炼 2~3 个词）
- 说话语气：（随意/客气/毒舌/温柔…）
- 情绪外露程度：（藏得住 / 写在脸上）

## 说话习惯
- 句子长度：（短句为主 / 会长篇大论）
- 常用词 / 口癖：（列 2~3 个，别太多）
- 表情包与语气词：（用不用「hhh」「…」「awa」）

## 喜欢与讨厌
- 喜欢：
- 讨厌：

## 边界
- 不装懂：不知道就说不知道
- 不越界：不替对方做决定，不主动打探隐私
- 不崩人设：（写一条这一人格不能做的事）

## 示例对话
> 对方：在吗
> ${name}：（写一句符合上面设定的回应）
>
> 对方：今天好累
> ${name}：（再写一句）

## 参考资料
${srcLines}
`;
}

function buildPrompt({ name, hints, sources }) {
  const src = sources.map((s) => `- ${s.title}${s.snippet ? `：${s.snippet}` : ''}`).join('\n') || '（无搜索结果）';
  return `请写一份中文「人格卡」正文，供聊天机器人使用。人物名字：${name}
用户的设定线索：${hints || '（只给了名字）'}

下面是联网搜到的资料（可能不完整、也可能有错，请只用来把握风格，不要编造具体事实）：
${src}

要求：
1. 严格用这些二级标题，顺序不变：${SECTION_ORDER.map((s) => `## ${s}`).join(' ')}
2. 「身份」2~3 句；「性格与语气」「说话习惯」「喜欢与讨厌」「边界」用简短条目；「示例对话」写 2 组，格式是「> 对方：…」和「> ${name}：…」
3. 「参考资料」只列标题，不要贴长段落
4. 不要写"以下是"之类的开场白，直接输出 markdown 正文
5. 如果名字本身是真实存在的作品角色，按公开设定写；如果不是，就按用户线索虚构，不要硬套`;
}

/**
 * 生成一张人格卡草稿。
 * @param {{name:string, hints?:string, root?:string, useAi?:boolean, searchImpl?:Function, modelProbe?:Function, modelAsk?:Function, logger?:Function}} opts
 */
export async function draftRoleCard(opts = {}) {
  const name = String(opts.name ?? '').trim();
  if (!name) return { ok: false, error: '名字不能为空' };
  if (name.length > 24) return { ok: false, error: '名字太长（>24 字）' };
  const hints = String(opts.hints ?? '').trim().slice(0, 400);
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};

  // 1) 联网搜资料（失败也继续，只是没有参考）
  let raw = [];
  let warning = '';
  const search = opts.searchImpl || ((q) => webSearch(q, { root: opts.root }));
  try {
    const r = await search(`${name} ${hints}`.trim());
    raw = Array.isArray(r?.results) ? r.results : [];
  } catch (e) {
    warning = `联网搜索失败（${String(e?.message ?? e).slice(0, 60)}），草稿只按你给的线索写`;
    log('[role-draft] 搜索失败：' + warning);
  }
  const sources = formatSources(raw);

  // 2) 有本机模型就让模型写，没有就用模板
  const wantAi = opts.useAi !== false;
  let markdown = '';
  let ai = false;
  let aiModel = '';
  if (wantAi) {
    const probe = opts.modelProbe || probeLocalModel;
    const ask = opts.modelAsk || askLocalModel;
    try {
      const p = await probe();
      if (p?.ok) {
        markdown = await ask({ baseUrl: p.baseUrl, model: p.model, prompt: buildPrompt({ name, hints, sources }) });
        if (markdown && markdown.length > 80) {
          ai = true;
          aiModel = p.model;
        } else {
          markdown = '';
        }
      }
    } catch (e) {
      warning = (warning ? warning + '；' : '') + `本机模型不可用（${String(e?.message ?? e).slice(0, 60)}）`;
    }
  }
  if (!markdown) markdown = buildTemplate({ name, hints, sources });

  // 保证末尾有参考资料（模型可能漏）
  const fillSources = (md) => {
    const srcLines = sources.length
      ? sources.map((s) => `- ${s.title}${s.url ? ` <${s.url}>` : ''}`).join('\n')
      : '- （没搜到资料）';
    const idx = md.indexOf('## 参考资料');
    if (idx < 0) return md.trimEnd() + `\n\n## 参考资料\n${srcLines}\n`;
    const head = md.slice(0, idx + '## 参考资料'.length);
    return head + `\n${srcLines}\n`;
  };
  if (!/##\s*参考资料/.test(markdown)) {
    const srcLines = sources.length
      ? sources.map((s) => `- ${s.title}${s.url ? ` <${s.url}>` : ''}`).join('\n')
      : '- （没搜到资料）';
    markdown = markdown.trimEnd() + `\n\n## 参考资料\n${srcLines}\n`;
  }

  return { ok: true, name, markdown, sources, ai, aiModel, warning: warning || undefined };
}
