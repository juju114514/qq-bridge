/**
 * 会话语料缓冲（插件侧）：每个会话一份环形缓冲 + 等待者队列。
 *
 * 为什么插件自己留一份：
 *   · /snapshot 里的 recent 是 sidecar 的视角（20 条，且可能没启用）
 *   · qq_wait_for_messages 必须"等新消息"，只有本进程知道什么时候真的来了新消息
 *   · 这份缓冲只进内存，重启就没了 —— 刻意的：持久化归 sidecar
 *
 * 容量：每会话 100 条（ring），足够覆盖一轮对话；不做过期清理，避免"刚说过就没了"。
 */

export const DEFAULT_CAPACITY = 100;

export function createChatLog({ capacity = DEFAULT_CAPACITY } = {}) {
  const logs = new Map();   // key -> [{ seq, at, userId, text, self }]
  const seqs = new Map();   // key -> 自增序号
  const readSeq = new Map(); // key -> 已读水位
  const waiters = new Map(); // key -> [{ resolve, timer, minNew }]

  function list(key) {
    return logs.get(key) ?? [];
  }

  function nextSeq(key) {
    const n = (seqs.get(key) ?? 0) + 1;
    seqs.set(key, n);
    return n;
  }

  /** 追加一条消息；返回它的 seq。self=true 表示机器人自己发的。 */
  function append(key, { text = '', userId = '', self = false, at = Date.now() } = {}) {
    const entry = { seq: nextSeq(key), at, userId: String(userId), text: String(text), self: Boolean(self) };
    const arr = logs.get(key) ?? [];
    arr.push(entry);
    if (arr.length > capacity) arr.splice(0, arr.length - capacity);
    logs.set(key, arr);
    // 唤醒等待者：只看"别人说的"，自己发的不算新消息
    if (!self) {
      const pending = waiters.get(key) ?? [];
      const stillWaiting = [];
      for (const w of pending) {
        if (entry.seq >= w.minNew) {
          clearTimeout(w.timer);
          w.resolve({ ok: true, entry });
        } else stillWaiting.push(w);
      }
      if (stillWaiting.length) waiters.set(key, stillWaiting);
      else waiters.delete(key);
    }
    return entry.seq;
  }

  function unread(key) {
    const since = readSeq.get(key) ?? 0;
    return list(key).filter((e) => e.seq > since && !e.self);
  }

  function recent(key, { limit = 20, offset = 0 } = {}) {
    const arr = list(key);
    const end = Math.max(0, arr.length - offset);
    const start = Math.max(0, end - limit);
    return arr.slice(start, end);
  }

  function markRead(key, throughSeq) {
    const seq = Number(throughSeq) || (seqs.get(key) ?? 0);
    readSeq.set(key, seq);
    return seq;
  }

  /** 等一条新消息（>= afterSeq）。超时返回 { ok:false, reason:'timeout' }。 */
  function waitFor(key, { timeoutMs = 30_000, afterSeq } = {}) {
    const minNew = Number.isFinite(afterSeq) ? Number(afterSeq) + 1 : ((seqs.get(key) ?? 0) + 1);
    return new Promise((resolve) => {
      const entry = { resolve, minNew };
      entry.timer = setTimeout(() => {
        const pending = (waiters.get(key) ?? []).filter((w) => w !== entry);
        if (pending.length) waiters.set(key, pending); else waiters.delete(key);
        resolve({ ok: false, reason: 'timeout' });
      }, Math.max(1000, Number(timeoutMs) || 30_000));
      // ⚠️ 不能 unref：等待是"有人真的在等这条消息"，unref 掉会让进程在空转时直接退出，
      //    宿主侧看到的是"工具调用悬空"（离线测试也复现了：unsettled top-level await）。
      const arr = waiters.get(key) ?? [];
      arr.push(entry);
      waiters.set(key, arr);
    });
  }

  function stats(key) {
    return {
      total: list(key).length,
      seq: seqs.get(key) ?? 0,
      readSeq: readSeq.get(key) ?? 0,
      waiting: (waiters.get(key) ?? []).length,
    };
  }

  return { append, unread, recent, markRead, waitFor, stats, list };
}