// 本地 agent 的人格注入（0.5.48 · C3 收尾）
//
// 为什么要单独一层：本地模式（agent.mode=local）之前只吃一句默认提示词，
// 和 DSH 模式的人格卡完全脱节 —— 同一个号在两种模式下说话方式会明显不一样。
//
// 取用顺序（先具体的、后兜底的）：
//   1. config.agent.persona        直接写一段话
//   2. config.agent.personaFile    指向一个 md/txt（桥接的人设文件通常是这种）
//   3. config.role.cardFile        角色卡（复用现有约定，如果存在）
//   4. 默认一句
import fs from 'node:fs';
import path from 'node:path';

const FALLBACK = '你是一个中文聊天助手，说话自然、简短，像真人在 QQ 上打字。';

/** 读一个文本文件，超过 maxChars 截断（人格不该把上下文吃光） */
function readText(file, maxChars) {
  try {
    const t = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t;
  } catch { return ''; }
}

/**
 * @param {{agent?:object, role?:object}} cfg
 * @param {{cwd?:string, maxChars?:number}} [opts]
 * @returns {{text:string, source:string}}
 */
export function resolvePersona(cfg = {}, opts = {}) {
  const { cwd = process.cwd(), maxChars = 3000 } = opts;
  const a = cfg.agent || {};

  const inline = String(a.persona || '').trim();
  if (inline) return { text: inline.length > maxChars ? `${inline.slice(0, maxChars)}…` : inline, source: 'agent.persona' };

  for (const [key, field] of [['agent.personaFile', a.personaFile], ['role.cardFile', cfg.role?.cardFile]]) {
    const f = String(field || '').trim();
    if (!f) continue;
    const abs = path.isAbsolute(f) ? f : path.join(cwd, f);
    const text = readText(abs, maxChars);
    if (text) return { text, source: `${key}(${path.basename(abs)})` };
  }

  return { text: FALLBACK, source: 'default' };
}

/** 拼成最终 system prompt：人格在前，行为约束在后 */
export function composeSystemPrompt({ persona, keyLine, base }) {
  const parts = [];
  if (persona) parts.push(persona);
  if (keyLine) parts.push(keyLine);
  if (base) parts.push(base);
  return parts.join('\n\n');
}
