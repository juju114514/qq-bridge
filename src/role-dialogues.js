// 人格「示例对话」（begin_dialogs，0.4.119）
//
// 抄的是 AstrBot 的思路（core/persona_mgr.py:464-490）：人格不靠形容词，靠**样例**。
// 它那边是把成对对话当真消息塞进上下文；我们这边没有消息层入口，
// 就先做成"注入到人格提示词里的示例片段"——比纯形容词强得多，而且零风险。
//
// 人格卡里这样写（`## 示例对话` 之后按「用户：/我：」成对）：
//
//   ## 示例对话
//   用户：今天好累啊
//   我：累就躺着，别硬撑。
//   用户：可是还有活没干完
//   我：那就明天再干，反正活又不会跑。
//
// 解析后这一节**从人格正文里摘掉**（避免重复占字符预算），只保留格式化后的示例。

const SECTION_RE = /^#{1,6}\s*(示例对话|示例|对话样例|examples?)\s*$/i;
const PAIR_RE = /^\s*(用户|user|对方|我说|我|助手|assistant)\s*[:：]\s*(.*)$/i;

/**
 * 从人格正文里拆出「示例对话」。
 * @param {string} body 人格卡正文（已去掉 front matter）
 * @returns {{body:string, pairs:Array<{role:'user'|'assistant', text:string}>}}
 */
export function extractDialogues(body) {
  const lines = String(body ?? '').split('\n');
  const kept = [];
  const pairs = [];
  let inSection = false;
  let sectionLevel = 0;

  for (const line of lines) {
    const m = SECTION_RE.exec(line.trim());
    if (m) { inSection = true; sectionLevel = (line.match(/^#+/) || ['#'])[0].length; continue; }
    if (inSection) {
      const heading = /^(#{1,6})\s+/.exec(line);
      // 遇到同级或更高级标题 → 本节结束
      if (heading && heading[1].length <= sectionLevel) { inSection = false; kept.push(line); continue; }
      const pm = PAIR_RE.exec(line);
      if (pm) {
        const who = pm[1].toLowerCase();
        const isUser = /^(用户|user|对方|我说)$/i.test(who);
        const text = pm[2].trim();
        if (text) pairs.push({ role: isUser ? 'user' : 'assistant', text });
      }
      // 节内的其它行（空行、说明）直接丢掉，不进正文也不进示例
      continue;
    }
    kept.push(line);
  }

  // 只保留成对的：末尾落单的助手/用户回复没有意义
  const balanced = pairs.length % 2 === 0 ? pairs : pairs.slice(0, -1);
  return { body: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), pairs: balanced };
}

/**
 * 格式化成注入块。空数组返回空串（调用方据此判断要不要拼）。
 * @param {Array<{role:'user'|'assistant', text:string}>} pairs
 * @param {{name?:string, maxPairs?:number}} opts name=人格自称，用于「我：」
 */
export function formatDialogues(pairs, { name = '', maxPairs = 6 } = {}) {
  const list = Array.isArray(pairs) ? pairs.slice(0, Math.max(2, maxPairs)) : [];
  if (!list.length) return '';
  const me = name ? name : '我';
  const lines = list.map((p) => `${p.role === 'user' ? '对方' : me}：${p.text}`);
  return `〔示例对话〕（下面是你说话的**语气样例**：学语气和节奏，不要照抄内容）\n${lines.join('\n')}`;
}


/**
 * 一步到位：给人格正文，返回「去掉示例节的正文」+「注入块」。
 * bridge 里只需要调这一个，避免它自己写 try/catch 与字符串处理（那里已到体积上限）。
 * @param {string} body
 * @param {string} roleName 人格自称（用于「我：」）
 */
export function splitForPrompt(body, roleName = '') {
  try {
    const ex = extractDialogues(body);
    if (!ex.pairs.length) return { body: String(body ?? ''), block: '' };
    return { body: ex.body, block: formatDialogues(ex.pairs, { name: String(roleName || '') }) };
  } catch {
    return { body: String(body ?? ''), block: '' };
  }
}
