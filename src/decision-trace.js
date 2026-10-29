// 决策追踪：回答"这条消息为什么没回我"。
//
// 背景：handleIncoming 里有 8 个"提前 return"的点（闸门/暂停/未命中唤醒/静默…），
// 以前每个都是沉默的 —— 机器人"在线但不说话"时只能人肉翻日志，今晚为此花了半小时。
// 这个模块把每条消息的决策链记进一个小环形缓冲，用 `/诊断` 一眼看清。
//
// 设计约束：
//   · 只记**决策**，不记聊天内容全文（截断 60 字），避免把隐私抄进内存日志
//   · 环形缓冲（默认 80 条），内存占用可忽略
//   · 全部 fail-soft：追踪本身绝不能影响消息处理

const STAGES = ['接收', '闸门', '元数据', '唤醒', '投递'];

function clip(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function createDecisionTrace({ max = 80, now = () => Date.now() } = {}) {
  const buffer = [];
  let seq = 0;

  function begin(meta = {}) {
    seq += 1;
    const rec = {
      seq,
      at: now(),
      key: String(meta.key ?? ''),
      kind: String(meta.kind ?? ''),
      messageId: meta.messageId ?? null,
      sender: String(meta.sender ?? ''),
      text: clip(meta.text),
      steps: [],
      outcome: ''
    };
    buffer.push(rec);
    while (buffer.length > max) buffer.shift();
    return rec;
  }

  function step(rec, stage, verdict, detail = '') {
    if (!rec) return rec;
    try { rec.steps.push({ stage: String(stage), verdict: String(verdict ?? ''), detail: clip(detail, 80) }); } catch { /* 忽略 */ }
    return rec;
  }

  function finish(rec, outcome) {
    if (!rec) return rec;
    try { rec.outcome = String(outcome ?? ''); } catch { /* 忽略 */ }
    return rec;
  }

  function recent({ key = '', limit = 8 } = {}) {
    const list = key ? buffer.filter((r) => r.key === String(key)) : buffer.slice();
    return list.slice(-Math.max(1, Math.min(50, limit)));
  }

  function find(idOrSeq) {
    const n = Number(idOrSeq);
    if (!Number.isFinite(n)) return null;
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      if (buffer[i].seq === n) return buffer[i];
      if (buffer[i].messageId != null && String(buffer[i].messageId) === String(idOrSeq)) return buffer[i];
    }
    return null;
  }

  function clear() { buffer.length = 0; }

  function formatTime(at) {
    const d = new Date(Number(at) || 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function formatOne(rec) {
    if (!rec) return '';
    const lines = [`#${rec.seq} ${formatTime(rec.at)} ${rec.key || '?'}${rec.messageId != null ? ` (消息 ${rec.messageId})` : ''}`];
    if (rec.text) lines.push(`  文本：${rec.text}`);
    for (const s of rec.steps) {
      lines.push(`  · ${s.stage}：${s.verdict}${s.detail ? `（${s.detail}）` : ''}`);
    }
    // 没有结果也是一种信息：说明它在闸门之后被某条**更早的**分支处理掉了
    // （公开命令/人设引导/快捷命令等），没走到投递 —— 排查时正是要找这种。
    lines.push(`  结果：${rec.outcome || '（未记录，可能在公开命令/人设流程里被处理）'}`);
    return lines.join('\n');
  }

  /** 给 /诊断 用的人话报告。 */
  function formatReport({ key = '', limit = 8 } = {}) {
    const list = recent({ key, limit });
    if (!list.length) {
      return key
        ? `【诊断】${key} 最近没有收到消息（或已超出缓冲 ${max} 条）`
        : `【诊断】最近没有消息记录（缓冲 ${max} 条，重启即清）`;
    }
    const head = key ? `【诊断】${key} 最近 ${list.length} 条` : `【诊断】最近 ${list.length} 条消息决策`;
    return [head, '', ...list.map((r) => formatOne(r))].join('\n');
  }

  return { begin, step, finish, recent, find, clear, formatOne, formatReport, stages: STAGES, size: () => buffer.length, max };
}