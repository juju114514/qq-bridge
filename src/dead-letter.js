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
      // guard-allow: renameSync 死信轮转（改名 .1，不是原子写）
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


/**
 * 取出死信（用于"重放"）：把匹配的条目从文件里摘掉，返回给调用方重新入队。
 * 只摘不删错：任何解析失败的行都会原样保留，不会因为一次重放把文件搞坏。
 *
 * @param {{ key?: string, limit?: number }} opts  key 为空表示取全部；limit 限制一次最多取几条
 * @returns {{ taken: object[], remaining: number }}
 */
export function takeDropped(file, { key = '', limit = 20 } = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  } catch {
    return { taken: [], remaining: 0 };
  }
  const taken = [];
  const keep = [];
  for (const line of lines) {
    let row = null;
    try { row = JSON.parse(line); } catch { keep.push(line); continue; }
    const match = !key || String(row?.key ?? '') === String(key);
    if (match && taken.length < Math.max(1, Number(limit) || 20)) taken.push(row);
    else keep.push(line);
  }
  try {
    if (keep.length) fs.writeFileSync(file, keep.join('\n') + '\n', 'utf8');
    else if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch { /* 写回失败：保持原样，调用方仍能重放已取出的条目 */ }
  return { taken, remaining: keep.length };
}

/** 统计（看有多少条、按原因分组）。 */
export function summarizeDropped(file) {
  const rows = readDropped(file, { limit: 10000 });
  const byReason = {};
  for (const r of rows) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  return { total: rows.length, byReason };
}
