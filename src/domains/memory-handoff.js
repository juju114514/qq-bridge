// 群记忆的「交接」段（§〇）——纯函数。
//
// 为什么单独做：评估 doc/docs/audits/luanyujia-workbench-2026-10-31.md 里最有价值的一条是
// 「记忆在文件里，不在会话里；换会话前先写交接」。换模型/重启之后，AI 不需要重新摸一遍群里的气氛。
//
// 约束（照抄那套规则，但用我们自己的规模）：
//   · 一个会话一份文件：state/memory/<key>.md
//   · `## §〇 交接` 是**覆盖写**的唯一一段，固定四个子项，**≤ 4 KB**
//   · 其余小节（§1 群印象 等）由别的流程追加，这里不碰
//
// 纯函数：给现有文本 + 新交接内容，返回新文本；不读盘、不写盘。

export const HANDOFF_MAX_BYTES = 4 * 1024;
export const HANDOFF_HEADING = '## §〇 交接';
const SUBHEADINGS = ['上次聊到哪', '当前话题', '记忆变更', '下一步想聊'];

/** 按 UTF-8 字节截断（不能按字符，中文 3 字节）。 */
export function truncateBytes(text, maxBytes = HANDOFF_MAX_BYTES) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out;
}

/** 把交接内容规范成 markdown（顺序固定，缺的项留空行，方便 diff）。 */
export function renderHandoff(input = {}) {
  const pick = (v) => String(v ?? '').trim();
  const lines = [HANDOFF_HEADING, ''];
  const values = {
    '上次聊到哪': pick(input.lastTalkedAbout),
    '当前话题': pick(input.currentTopics),
    '记忆变更': pick(input.memoryChanges),
    '下一步想聊': pick(input.nextStep),
  };
  for (const key of SUBHEADINGS) {
    lines.push(`### ${key}`, values[key] || '（暂无）', '');
  }
  const text = lines.join('\n').trimEnd() + '\n';
  return truncateBytes(text, HANDOFF_MAX_BYTES);
}

/** 从整份记忆文件里取出交接段（没有就返回空串）。 */
export function extractHandoff(fileText) {
  const s = String(fileText ?? '');
  const start = s.indexOf(HANDOFF_HEADING);
  if (start < 0) return '';
  const rest = s.slice(start + HANDOFF_HEADING.length);
  const next = rest.search(/^## §[1-9]/m); // 下一个 §n 小节
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

/** 用新交接段替换（或插入到文件开头）旧交接段；其它内容原样保留。 */
export function upsertHandoff(fileText, handoffMarkdown) {
  const s = String(fileText ?? '');
  const block = String(handoffMarkdown ?? '').trimEnd() + '\n';
  const start = s.indexOf(HANDOFF_HEADING);
  if (start < 0) {
    return block + (s.trim() ? '\n' + s.replace(/^\n+/, '') : '');
  }
  const rest = s.slice(start + HANDOFF_HEADING.length);
  const next = rest.search(/^## §[1-9]/m);
  if (next < 0) return s.slice(0, start) + block;
  return s.slice(0, start) + block + '\n' + rest.slice(next);
}

/** 交接段是否"够新鲜"：有内容且不超过上限。给 check 用。 */
export function checkHandoff(fileText) {
  const block = extractHandoff(fileText);
  if (!block) return { ok: false, reason: 'missing', bytes: 0 };
  const bytes = Buffer.byteLength(block, 'utf8');
  if (bytes > HANDOFF_MAX_BYTES) return { ok: false, reason: 'too-large', bytes };
  if (/（暂无）/.test(block) && (block.match(/（暂无）/g) || []).length >= SUBHEADINGS.length) {
    return { ok: false, reason: 'empty', bytes };
  }
  return { ok: true, reason: 'ok', bytes };
}