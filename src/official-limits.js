// 官方通道的配额常量与 msg_seq 计数（0.4.113）
//
// 单独成文件：qqbot-official.js 已接近体积上限，而这块是纯计数逻辑，跟 WS/HTTP 无关。
/**
 * 被动回复的 msg_seq 计数。
 *
 * 官方限制（消息收发概述）：
 *   · 群聊：5 分钟内最多 5 条
 *   · 单聊：**60 分钟内最多 4 条**（以前我们群聊单聊都按 5 算，单聊第 5 条必被拒）
 * 所以这里按 kind 区分上限，并给每条 msg_id 记一个过期时间——过期后不该再尝试被动回复。
 */
export const PASSIVE_LIMITS = {
  group: { max: 5, ttlMs: 5 * 60 * 1000 },
  private: { max: 4, ttlMs: 60 * 60 * 1000 }
};

export class ReplySeqTracker {
  constructor(limits = PASSIVE_LIMITS) {
    this.limits = limits;
    this.map = new Map();   // msgId -> { used, expiresAt }
  }

  /**
   * @param {string} msgId 触发消息的 msg_id
   * @param {'group'|'private'} kind
   * @param {number} [now]
   * @returns {number|null} 下一次可用的 msg_seq；null = 配额用完或已过期
   */
  next(msgId, kind = 'group', now = Date.now()) {
    const key = String(msgId ?? '');
    if (!key) return null;
    const limit = this.limits[kind] ?? this.limits.group;
    const rec = this.map.get(key);
    if (!rec || now > rec.expiresAt) {
      const fresh = { used: 1, expiresAt: now + limit.ttlMs };
      this.map.set(key, fresh);
      this._sweep(now);
      return 1;
    }
    if (rec.used >= limit.max) return null;
    rec.used += 1;
    return rec.used;
  }

  _sweep(now) {
    if (this.map.size <= 500) return;
    for (const [k, v] of this.map) {
      if (now > v.expiresAt) this.map.delete(k);
    }
    // 还是太多就丢最早的一批
    while (this.map.size > 500) {
      this.map.delete(this.map.keys().next().value);
    }
  }
}

