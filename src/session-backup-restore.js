// 会话备份恢复（0.4.99）
//
// 用户："11-01 05:58 100000001会话记录恢复一下，还有加上支持恢复较久的会话记录"
//
// 两件事：
//   1) 备份要**真的能恢复** —— 原来快照只存 `messages`，可 socialV2 的历史其实在
//      `recentMessages` 里，于是备份出来是"0 条消息"，恢复等于没恢复。
//   2) 恢复不设时效：**多老的备份都能恢复**（只按文件名取，不看过期）。

const DEDUPE_FIELDS = ['messageId', 'seq'];

function keyOf(item) {
  if (!item || typeof item !== 'object') return '';
  for (const f of DEDUPE_FIELDS) {
    const v = item[f];
    if (v !== undefined && v !== null && v !== '') return `${f}:${v}`;
  }
  return `text:${String(item.text ?? item.plain ?? '')}`;
}

/** 合并两个消息数组：以 live 为准，把 snapshot 里 live 没有的补进去（按时间/序号排序） */
export function mergeMessages(live = [], snapshot = [], { max = 200 } = {}) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(live) ? live : []) {
    const k = keyOf(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  let added = 0;
  for (const item of Array.isArray(snapshot) ? snapshot : []) {
    const k = keyOf(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    added += 1;
  }
  out.sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  return { list: out.slice(-max), added };
}

/**
 * 由备份快照算出"要写回会话的补丁"。
 * 兼容老备份：老快照没有 recentMessages，就从 messages / unread 里尽量捞。
 */
export function buildRestorePatch({ snapshot = {}, live = {}, includeUnread = false } = {}) {
  const snapRecent = Array.isArray(snapshot.recentMessages) ? snapshot.recentMessages : [];
  const snapMessages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const snapUnread = Array.isArray(snapshot.unread) ? snapshot.unread : [];
  const fallback = snapRecent.length ? snapRecent : (snapMessages.length ? snapMessages : snapUnread);

  const liveRecent = Array.isArray(live.recentMessages) ? live.recentMessages : [];
  const liveUnread = Array.isArray(live.unread) ? live.unread : [];

  const recent = mergeMessages(liveRecent, fallback);
  const unread = includeUnread ? mergeMessages(liveUnread, snapUnread) : { list: liveUnread, added: 0 };

  return {
    key: String(snapshot.key || live.key || ''),
    recentMessages: recent.list,
    unread: unread.list,
    addedRecent: recent.added,
    addedUnread: unread.added,
    longTerm: Array.isArray(snapshot.longTerm) ? snapshot.longTerm : null
  };
}

/** 备份里到底有多少可恢复的记录（用于界面显示"能恢复几条"） */
export function restorableCount(snapshot = {}) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const pick = (v) => (Array.isArray(v) ? v.length : 0);
  return {
    recent: pick(s.recentMessages) || pick(s.messages) || pick(s.unread),
    unread: pick(s.unread),
    longTerm: pick(s.longTerm)
  };
}
