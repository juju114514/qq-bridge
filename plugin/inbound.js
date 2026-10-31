/**
 * 入站策略（纯函数 + 一个小状态机，不碰网络）。
 *
 * 把"这条消息要不要处理"从连接层里拆出来，这样能用假事件穷举，
 * 不必连 QQ 才知道为什么它不回。
 *
 * 判定顺序（短路，第一个不通过就丢）：
 *   1. 不是消息事件            → skip:not-message
 *   2. 自己发的                  → skip:self
 *   3. 群不在白名单              → skip:group-not-allowed（空白名单 = 谁都不回，与桥接一致）
 *   4. 群消息且要求 @ 但没 @ 它   → skip:no-mention
 *   5. 纯文本为空               → skip:empty
 *   6. 同一个 message_id 重复    → skip:duplicate
 */

const MAX_SEEN = 2000;

/** 从 OneBot 消息段里抽纯文本；兼容 message 是字符串的老实现。 */
export function extractText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .filter((seg) => seg && seg.type === 'text' && typeof seg.data?.text === 'string')
    .map((seg) => seg.data.text)
    .join('');
}

/** 这条消息有没有 @ 到指定 QQ（默认用 self_id）。 */
export function mentionsSelf(event, selfId) {
  const target = String(selfId ?? event?.self_id ?? '');
  if (!target) return false;
  const segs = Array.isArray(event?.message) ? event.message : [];
  return segs.some((seg) => {
    if (!seg || seg.type !== 'at') return false;
    const qq = String(seg.data?.qq ?? '');
    return qq === target;
  });
}

/** 会话 key：与桥接/控制台同一种格式。 */
export function chatKeyOf(event) {
  if (event?.message_type === 'group') return `group:${event.group_id}`;
  if (event?.message_type === 'private') return `private:${event.user_id}`;
  return '';
}

export function createInboundGate(config = {}) {
  const allowGroups = new Set((config.allowGroups ?? []).map((x) => Number(x)).filter(Number.isFinite));
  const requireMention = config.requireMention !== false;
  const seen = new Map(); // message_id -> ts

  function remember(id) {
    if (id === undefined || id === null || id === '') return false;
    const key = String(id);
    if (seen.has(key)) return true; // 重复
    seen.set(key, Date.now());
    if (seen.size > MAX_SEEN) {
      // 简单的 LRU 近似：删最旧的一批
      const drop = seen.size - MAX_SEEN;
      let i = 0;
      for (const k of seen.keys()) { if (i++ >= drop) break; seen.delete(k); }
    }
    return false;
  }

  return function decide(event, { selfId } = {}) {
    if (!event || (event.post_type !== 'message' && event.message_type === undefined)) {
      return { handle: false, reason: 'not-message' };
    }
    const self = String(selfId ?? event.self_id ?? '');
    if (self && String(event.user_id) === self) return { handle: false, reason: 'self' };

    const key = chatKeyOf(event);
    if (!key) return { handle: false, reason: 'not-message' };

    if (event.message_type === 'group') {
      // 空白名单 = 谁都不回（和桥接同一条语义，别让"没配"变成"全都回"）
      if (!allowGroups.has(Number(event.group_id))) return { handle: false, reason: 'group-not-allowed' };
      if (requireMention && !mentionsSelf(event, self)) return { handle: false, reason: 'no-mention' };
    }

    const text = extractText(event.message).trim();
    if (!text) return { handle: false, reason: 'empty' };
    if (remember(event.message_id)) return { handle: false, reason: 'duplicate' };

    return { handle: true, key, text, userId: String(event.user_id ?? ''), groupId: event.group_id ?? null };
  };
}