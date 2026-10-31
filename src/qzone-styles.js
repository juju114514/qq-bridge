// 空间说说的「语气风格」模块（0.4.78）
//
// 为什么单独一个模块：
//   · 风格是**产品判断**（哪种口吻像人、哪种像营销号），不该散在 prompt 字符串里
//   · 用户可能一次挑好几个（"日常"+"吐槽"各来一条），也可能让 AI 自己定
//   · 以后要加风格（比如"深夜 emo""报平安"）只改这里，不动路由与界面
//
// 纯数据 + 纯函数，便于单测。

/** 风格目录：id 稳定（存进 state），label 给人看，hint 给模型看 */
export const STYLE_CATALOG = Object.freeze([
  {
    id: 'daily',
    label: '日常',
    hint: '像随手记一笔：今天做了什么、看到什么，平铺直叙，不煽情，少量口语词',
    length: [40, 120],
    emoji: '少'
  },
  {
    id: 'funny',
    label: '吐槽',
    hint: '带点自嘲和梗，吐槽一件小事，但别刻薄、别骂人、别阴阳怪气',
    length: [30, 100],
    emoji: '可以 0~2 个'
  },
  {
    id: 'soft',
    label: '文艺',
    hint: '短句、留白、写具体画面而不是空泛感慨，**不要鸡汤和"愿你我"那套**',
    length: [30, 90],
    emoji: '不用'
  },
  {
    id: 'tech',
    label: '技术',
    hint: '技术人视角：今天折腾了什么、踩了什么坑、怎么绕过去的，少术语堆砌',
    length: [40, 120],
    emoji: '少'
  },
  {
    id: 'auto',
    label: '让它自己定',
    hint: '你自己挑最合适的语气，但只能选一种，不要混合',
    length: [30, 120],
    emoji: '按语气来'
  }
]);

const BY_ID = new Map(STYLE_CATALOG.map((s) => [s.id, s]));

export const STYLE_IDS = Object.freeze(STYLE_CATALOG.map((s) => s.id));

/** 最多允许同时挑几个（多了会变成刷屏，一条说说一件事就够） */
export const MAX_STYLES = 3;

/**
 * 把用户输入（数组/字符串/空）解析成合法风格列表。
 * 规则：去重、丢掉未知 id、空则回落到 auto、超过 MAX_STYLES 截断。
 */
export function resolveStyles(input) {
  const raw = Array.isArray(input) ? input : (input ? [input] : []);
  const out = [];
  for (const item of raw) {
    const id = String(item ?? '').trim().toLowerCase();
    if (!id || !BY_ID.has(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  if (!out.length) return ['auto'];
  return out.slice(0, MAX_STYLES);
}

/** 标题用：["daily","funny"] → "日常 / 吐槽" */
export function describeStyles(styles) {
  return resolveStyles(styles).map((id) => BY_ID.get(id)?.label || id).join(' / ');
}

/**
 * 生成投给 agent 的 prompt。
 * @param {object} p
 * @param {string[]|string} p.styles   用户挑的风格（可多个）
 * @param {string} p.hint              想写的内容
 * @param {string} p.recent            最近素材
 */
export function buildStylePrompt({ styles = ['auto'], hint = '', recent = '' } = {}) {
  const picked = resolveStyles(styles);
  const defs = picked.map((id) => BY_ID.get(id)).filter(Boolean);

  const lines = ['【空间草稿请求】'];

  if (picked.length === 1) {
    lines.push('帮我写一条 QQ 空间说说。');
    lines.push(`风格：${defs[0].hint}。`);
    lines.push(`长度：${defs[0].length[0]}~${defs[0].length[1]} 字；表情：${defs[0].emoji}。`);
  } else {
    lines.push(`帮我写 ${picked.length} 条 QQ 空间说说，**每种风格各一条**。`);
    lines.push('每条都用【风格名】开头单独一行，风格名只能用下面这几个：');
    for (const d of defs) lines.push(`- 【${d.label}】${d.hint}（${d.length[0]}~${d.length[1]} 字，表情：${d.emoji}）`);
  }

  lines.push('硬要求（每条都要遵守）：');
  lines.push('1. 【标签】那行之后才是正文；正文里不要重复风格名、不要加引号、不要解释；');
  lines.push('2. 像自己随手发的，不像广告、不像文案；');
  lines.push('3. 不要提"我是AI/机器人"，不要暴露群号、QQ号、链接、别人隐私；');
  lines.push('4. 一条只说一件事，不要列点、不要小标题。');

  if (String(hint || '').trim()) lines.push(`想写的内容/主题：${String(hint).trim().slice(0, 120)}`);
  if (String(recent || '').trim()) lines.push(`最近的素材（可参考，不必照抄）：${String(recent).trim().slice(0, 600)}`);

  return lines.join('\n');
}

/**
 * 把 agent 的整段回复拆成候选：[{style, label, text}]
 * 兼容三种情况：
 *   · 带【风格】标签的多条
 *   · 只有编号 1. 2. 的多条
 *   · 一整段（单条）
 */
export function parseStyleReply(reply, styles = ['auto']) {
  const picked = resolveStyles(styles);
  const labelToId = new Map(STYLE_CATALOG.map((s) => [s.label, s.id]));
  const lines = String(reply || '').replace(/\r/g, '').split('\n');

  const buckets = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\s*[【\[]\s*([^】\]]{1,8})\s*[】\]]\s*(.*)$/);
    if (m && labelToId.has(m[1].trim())) {
      current = { style: labelToId.get(m[1].trim()), body: [m[2] || ''] };
      buckets.push(current);
      continue;
    }
    const n = line.match(/^\s*[1-9][.、)]\s+(.*)$/);
    if (!current && n) {
      current = { style: picked[0] || 'auto', body: [n[1]] };
      buckets.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }

  const cleaned = buckets
    .map((b) => ({
      style: b.style,
      label: BY_ID.get(b.style)?.label || b.style,
      text: String(b.body.join('\n')).trim().slice(0, 300)
    }))
    .filter((c) => c.text);

  if (cleaned.length) return cleaned.slice(0, MAX_STYLES);

  // 整段回复（没有标签）：当成第一条风格
  const whole = String(reply || '').trim().slice(0, 300);
  return whole ? [{ style: picked[0] || 'auto', label: BY_ID.get(picked[0])?.label || '草稿', text: whole }] : [];
}
