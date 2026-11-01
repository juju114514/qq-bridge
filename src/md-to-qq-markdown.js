// 标准 Markdown → QQ 官方 Markdown（0.4.115）
//
// 为什么要转换：官方只支持一个**子集**（官方「Markdown 消息」页的支持列表）：
//   支持：#/## 标题、**加粗**、__下划线__、_斜体_、*斜体*、~~删除线~~、链接、图片、列表、引用、*** 分割线
//   不支持（文档没列，实测也不渲染）：表格、代码块围栏、行内 code、HTML
//
// 所以这里不是"压成纯文本"（那是 md-to-plain.js 的活），而是"保留能渲染的、把不能渲染的换掉"。
import { mdToPlain } from './md-to-plain.js';

/**
 * 把标准 markdown 转成 QQ 能渲染的 markdown。
 * @param {string} input
 * @returns {string}
 */
export function toQqMarkdown(input) {
  let t = String(input ?? '').replace(/\r\n/g, '\n');
  if (!t.trim()) return '';

  // 1) 代码块围栏：去掉 ``` 与语言标记，保留内容（QQ 不渲染代码块）
  t = t.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, code) => String(code).trim());

  // 2) 行内 code：去反引号（否则会原样显示反引号）
  t = t.replace(/`([^`\n]+)`/g, '$1');

  // 3) HTML 标签直接删（QQ 不接受 HTML）
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // 4) 表格：| a | b | 这种转成 "a · b" 列表，去掉分隔行
  const lines = t.split('\n');
  const out = [];
  for (const line of lines) {
    const isTable = /^\s*\|.*\|\s*$/.test(line);
    // 只能是"表格分隔行"才算：必须带竖线，否则 `---` 会被误当成表格吃掉
    const isSep = line.includes('|') && /^[\s|:-]+$/.test(line) && line.includes('-');
    if (isSep) continue;                       // 表头分隔线（|---|---|）整行丢掉
    if (isTable) {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length) out.push('· ' + cells.join(' · '));
      continue;
    }
    // 5) --- / ___ 分隔线 → ***（官方只演示了 ***）
    if (/^\s*(-{3,}|_{3,})\s*$/.test(line)) { out.push('***'); continue; }
    out.push(line);
  }
  t = out.join('\n');

  // 6) 图片语法保留（官方支持 ![alt](url)，但要求公网可访问）
  // 7) 压缩多余空行（QQ 里连续空行会被吃掉，留着也白留）
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/**
 * 这条 markdown 有没有"值得发 markdown"的东西。
 * 纯文本（没有标题/加粗/列表/链接/引用/删除线/分割线）就发文本更稳，
 * 免得为了一个标点去冒降级的风险、白烧一次被动回复配额。
 */
export function hasMarkdownSyntax(input) {
  const t = String(input ?? '');
  if (!t) return false;
  return /(^|\n)\s{0,3}#{1,2}\s/.test(t)      // 标题
    || /\*\*[^*\n]+\*\*/.test(t)             // 加粗
    || /__[^_\n]+__/.test(t)                 // 下划线加粗
    || /~~[^~\n]+~~/.test(t)                 // 删除线
    || /\[[^\]\n]+\]\([^)\s]+\)/.test(t)     // 链接
    || /(^|\n)\s{0,3}>\s/.test(t)            // 引用
    || /(^|\n)\s*[-*+]\s+\S/.test(t)         // 无序列表
    || /(^|\n)\s*\d+\.\s+\S/.test(t)         // 有序列表
    || /(^|\n)\s*\*\*\*\s*(\n|$)/.test(t);   // 分割线
}

/**
 * 兜底：markdown 发不出去时用它的纯文本版本重发。
 * 直接复用现有 mdToPlain，避免两套"去标记"逻辑各自漂移。
 */
export function markdownFallbackText(input) {
  return mdToPlain(String(input ?? ''));
}
