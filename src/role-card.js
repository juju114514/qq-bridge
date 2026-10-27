// 人格卡（roles/<名称>.md）的解析与「按仿真模式取用」。
//
// 为什么要分模式：
//   一代仿真（reserved）用空格分条、用 [SILENT] 表示沉默；
//   二代仿真（reserved2）必须用工具发言（qq_send_message 的数组分条），没有 [SILENT]。
//   同一张人格卡被两种模式共用时，一代专属指令会与二代工具协议冲突。
// 以前靠 currentRoleHintV2() 对正文做「逐行猜测 + 正则过滤」，既容易误伤又说不清边界。
//
// 现在改为显式标记：在标题里写模式，桥接只取当前模式适用的小节。
//   ## 表情包体系 〔二代〕      → 只在 reserved2 注入
//   ## 分条方式 〔一代〕        → 只在 reserved/chat 注入
//   ## 你是谁                   → 两种模式都注入
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
export const ROLE_INJECT_MODES = ['v1', 'v2'];

// 模式标记：`〔二代〕` / `[v2]` / `（reserved2）` 等写法都认。
const MODE_TAGS = [
  { mode: 'v2', re: /[\[〔（(]\s*(?:二代|2\s*代|v2|reserved2)\s*[\]〕）)]/gi },
  { mode: 'v1', re: /[\[〔（(]\s*(?:一代|1\s*代|v1|reserved)\s*[\]〕）)]/gi },
];

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    if (tag.re.test(heading)) return tag.mode;
  }
  return 'all';
}

const NEED_TAG_RE = /〔按需[:：]([^〕]+)〕/g;

/** 从标题里抽出「按需」标签：只有当上下文命中这些词时才注入该小节。 */
function detectNeeds(heading) {
  const out = [];
  const src = String(heading ?? '');
  NEED_TAG_RE.lastIndex = 0;
  let m;
  while ((m = NEED_TAG_RE.exec(src)) !== null) {
    for (const tag of String(m[1]).split(/[,，、\s]+/)) {
      const t = tag.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

function stripNeedTags(heading) {
  return String(heading ?? '').replace(/〔按需[:：][^〕]+〕/g, '').trim();
}

function stripModeTags(heading) {
  let out = String(heading);
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    out = out.replace(tag.re, '');
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 按标题把人格卡拆成小节。
 * @returns {{mode: 'all'|'v1'|'v2', heading: string|null, lines: string[]}[]}
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  // 传进来的可能是「含 front matter 的整篇」，也可能是已经剥过的正文 ——
  // parseRoleFrontMatter 对两者都安全（没有元数据时原样返回）。
  text = parseRoleFrontMatter(text).body;
  // 去掉开头的 UTF-8 BOM：Windows 上 PowerShell 5.1 / 旧记事本 / VS Code 的某些保存
  // 方式会给文件加 BOM，而带 BOM 时首行是 `\ufeff# 角色卡…`，`/^#{1,6}\s/` 匹配不上
  // ⇒ 一级标题被当成普通正文（控制台的章节统计、模式标记都会跟着错位）。
  // 实测就踩过：roles/小鲸鱼（已测试）.md 带 BOM，H1 一直没被识别成标题。
  for (const line of String(text ?? '').replace(/^\uFEFF/, '').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const title = stripNeedTags(stripModeTags(heading[2]));
    current = { mode: detectMode(heading[2]), needs: detectNeeds(heading[2]), heading: title, lines: [`${heading[1]} ${title}`] };
    sections.push(current);
  }
  return sections;
}

/**
 * 取出某次仿真真正要注入的人格文本（已去掉模式标记）。
 * @param {'v1'|'v2'} mode
 */
function needActive(section, active) {
  const needs = Array.isArray(section.needs) ? section.needs : [];
  if (!needs.length) return true;
  if (!active || !active.length) return false;
  const list = [...active].map((x) => String(x));
  return needs.some((n) => list.some((a) => a.includes(n) || n.includes(a)));
}

export function selectRoleText(text, mode, activeNeeds = []) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  // 统一剥掉 front matter（`id:` / `name:`）：元数据不是人设，任何注入路径都不该带它。
  // 放在这里而不是让每个调用方自己剥 —— 少一个调用方忘记，就多 39 个字符的脏内容。
  return parseRoleSections(parseRoleFrontMatter(text).body)
    .filter((section) => section.mode === 'all' || section.mode === want)
    .filter((section) => needActive(section, activeNeeds))
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 报告每个小节在当前模式下是否会被注入，供控制台预览。
 * @param {'v1'|'v2'} mode
 */
export function roleSectionReport(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text).map((section) => ({
    heading: section.heading ?? '(开头部分)',
    mode: section.mode,
    injected: (section.mode === 'all' || section.mode === want) && (!section.needs || !section.needs.length),
    needs: section.needs || [],
    chars: section.lines.join('\n').trim().length,
  }));
}

/** 统计各模式的字符数，用于控制台提示「去掉另一模式的专属小节后还剩多少」。 */
export function roleCharStats(text) {
  const source = String(text ?? '');
  const sections = parseRoleSections(source);
  const sum = (list) => list.reduce((total, section) => total + section.lines.join('\n').trim().length, 0);
  return {
    total: source.length,
    common: sum(sections.filter((section) => section.mode === 'all')),
    v1Only: sum(sections.filter((section) => section.mode === 'v1')),
    v2Only: sum(sections.filter((section) => section.mode === 'v2')),
    v1: selectRoleText(source, 'v1').length,
    v2: selectRoleText(source, 'v2').length,
  };
}

// 一代仿真遗留指令：未加模式标记时，这些行在二代下会被兜底过滤。
// 正确做法是给所在小节加上 〔一代〕 标记。
export const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;


// ── 角色卡元数据（front matter）──────────────────────────────────────────────
//
// 为什么要有这层：角色卡的**文件名**长期兼任身份（`roles/<名字>.md`），于是
// 名字里带全角括号、改了名、丢了后缀，`/role`、会话绑定、控制台全跟着失效
// （实测踩过三次）。现在改成：
//
//   roles/<任意文件名>.md      ← 文件名只是存放位置，随便改
//     ---
//     id: xiaojingyu          ← 稳定身份（状态文件只存这个）
//     name: 小鲸鱼（已测试）      ← 显示名，随便改
//     ---
//     # 角色卡…
//
// 老文件（没有 front matter）仍然能用：id 取文件名的确定性哈希，name 取文件名，
// 迁移脚本 scripts/migrate-roles-to-ids.mjs 会一次性补上元数据。

const FRONT_MATTER_DELIM = '---';

/**
 * 解析角色卡首部的 YAML 子集（只认 `id:` / `name:` 两个键，够用且不需要 yaml 依赖）。
 * @returns {{ id: string|null, name: string|null, body: string, hasMeta: boolean }}
 */
export function parseRoleFrontMatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const lines = src.split('\n');
  if (!/^---\s*$/.test(lines[0] ?? '')) {
    return { id: null, name: null, body: src, hasMeta: false };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return { id: null, name: null, body: src, hasMeta: false };

  const meta = { id: null, name: null };
  for (const line of lines.slice(1, end)) {
    const m = /^(id|name)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2].trim();
    // 去掉包裹的引号（YAML 允许 "x" / 'x'）
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (value) meta[m[1]] = value;
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { id: meta.id, name: meta.name, body, hasMeta: true };
}

/** 拼一段 front matter（只写 id/name，保持可人读）。 */
export function buildRoleFrontMatter({ id, name }) {
  const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
  const idLine = clean(id);
  const nameLine = clean(name);
  if (!idLine) throw new Error('角色卡缺 id');
  return `${FRONT_MATTER_DELIM}\nid: ${idLine}\nname: ${nameLine || idLine}\n${FRONT_MATTER_DELIM}\n`;
}

/**
 * 把显示名压成可读的 ASCII id；中文名压不出可读结果时返回 null（由调用方回退到哈希）。
 * 仅用于**生成** id，不用于校验——id 一旦生成就不再随名字变化。
 */
export function slugifyRoleId(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!slug) return null;
  // 纯数字开头会撞 Windows 设备名判断，统一加前缀
  return /^[a-z]/.test(slug) ? slug : `r-${slug}`;
}

/**
 * 老文件（无 front matter）的确定性 id：同一个文件名永远得到同一个 id，
 * 换机器/重装都一致；但改了文件名就会变 —— 这也是迁移脚本存在的理由。
 */
export function hashRoleId(fileStem) {
  const s = String(fileStem ?? '');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `r-${h.toString(36).padStart(7, '0')}`;
}
