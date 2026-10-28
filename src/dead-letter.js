// 死信（dead letter）：本该投递、但被丢弃的消息**不再凭空消失**。
//
// 为什么需要：队列满（50 条）时旧实现只打一行日志就把最旧那条丢掉；
// 恢复队列后如果会话已不在白名单，也会"补投跳过"直接扔。
// 用户那条消息就这样没了，而且没有任何地方能查。
//
// 现在统一写进 state/pending-queue-dropped.jsonl：
//   { at, key, reason, promptText }
// 运营者可以 `grep`/`cat` 查看，也可以手动把 promptText 再发一次。
// 文件超过上限就轮转成 .1（保留一份历史），不会无限膨胀。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** 追加一条死信。失败不抛（丢弃路径本身不能再制造异常）。 */
export function appendDropped(file, entry, { maxBytes = DEFAULT_MAX_BYTES, now = new Date() } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 轮转：超过上限就把当前文件挪成 .1（覆盖旧的 .1）
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
    } catch { /* 文件不存在时忽略 */ }
    const line = JSON.stringify({
      at: now.toISOString(),
      key: String(entry?.key ?? ''),
      reason: String(entry?.reason ?? 'unknown'),
      promptText: String(entry?.promptText ?? '').slice(0, 4000)
    });
    fs.appendFileSync(file, line + '\n', 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 读死信（调试/恢复用）。坏行跳过，不影响其它行。 */
export function readDropped(file, { limit = 50 } = {}) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

/** 统计（看有多少条、按原因分组）。 */
export function summarizeDropped(file) {
  const rows = readDropped(file, { limit: 10000 });
  const byReason = {};
  for (const r of rows) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  return { total: rows.length, byReason };
}
