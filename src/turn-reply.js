// 回合收尾：这段回复"要不要发"的判定。
//
// 三个 `continue` 分支看着简单，但每个都对应一个用户能感知的事故：
//   · 只有格式/空白（纯 Markdown、空串）→ 不能发，否则 QQ 里出现一条空消息
//   · AI 主动选择静默（输出静默标记）→ 不能发，这是"潜水"
//   · 本轮已经用发送工具发过了 → 不能再自动转发，否则同一句话发两遍
//
// 抽成纯函数是为了让这三个判断能被穷举测试 —— 它们藏在 pumpMux 里时，
// 只能靠"发一条试试"来验证。

/** @returns {{ action: 'skip'|'send', reason: 'empty'|'silent'|'already-sent'|'' }} */
export function decideReplyAction({ kind, text, sendToolSucceeded = false, isSilent = false } = {}) {
  // 只有正常完成的回合才谈得上发送
  if (kind !== 'completed') return { action: 'skip', reason: 'empty' };
  if (!String(text ?? '').trim()) return { action: 'skip', reason: 'empty' };
  if (isSilent) return { action: 'skip', reason: 'silent' };
  if (sendToolSucceeded) return { action: 'skip', reason: 'already-sent' };
  return { action: 'send', reason: '' };
}