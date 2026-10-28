// 私聊准入：好友可以私聊，临时会话一律拒绝。
//
// 为什么这么设计：
//   · 临时会话（非好友）在 QQ 网关实现里**时好时坏** —— 消息能进、回复发不出去，
//     表现成"它不回我"，排查成本极高。
//   · 好友关系是稳定通道；所以策略是：只服务好友，临时会话不接。
//
// 默认关闭（new install 不开）：不主动接任何私聊，避免装完被陌生人骚扰。

import { normalizeScope } from './sticker-notes.js';

export const DEFAULT_PRIVATE_ACCESS = {
  enabled: false,        // 总开关：新装默认关
  allowFriends: true,    // 开了之后：好友可以聊
  allowStrangers: false, // 临时会话/陌生人：不接（网关不稳）
  friendListTtlMs: 10 * 60 * 1000
};

export const PRIVATE_DENY = Object.freeze({
  DISABLED: 'disabled',
  NOT_FRIEND: 'not-friend',
  TEMP_SESSION: 'temp-session',
  NOT_IN_ALLOWLIST: 'not-in-allowlist'
});

/**
 * 判断一条私聊是否该处理。
 * @param {{enabled?:boolean, allowFriends?:boolean, allowStrangers?:boolean}} opts 配置
 * @param {{isFriend?:boolean, isTemp?:boolean, inAllowList?:boolean, userId?:string}} ctx 上下文
 */
export function decidePrivateAccess(opts = {}, ctx = {}) {
  const c = { ...DEFAULT_PRIVATE_ACCESS, ...(opts || {}) };
  if (c.enabled !== true) return { allowed: false, reason: PRIVATE_DENY.DISABLED };

  // 白名单优先：显式允许的人，即使不是好友也放行（便于测试/自用）
  if (ctx.inAllowList === true) return { allowed: true, reason: 'allowlist' };

  if (ctx.isTemp === true) {
    // 临时会话：即使 allowStrangers 也默认拒绝（网关不稳，见文件头注释）
    if (c.allowStrangers === true && ctx.isTemp !== true) return { allowed: true, reason: 'stranger' };
    return { allowed: false, reason: PRIVATE_DENY.TEMP_SESSION };
  }

  if (ctx.isFriend === true) {
    return c.allowFriends === true
      ? { allowed: true, reason: 'friend' }
      : { allowed: false, reason: PRIVATE_DENY.NOT_IN_ALLOWLIST };
  }

  if (c.allowStrangers === true) return { allowed: true, reason: 'stranger' };
  return { allowed: false, reason: PRIVATE_DENY.NOT_FRIEND };
}

/** 好友名单缓存要不要刷新。 */
export function friendListStale(cachedAt, now = Date.now(), opts = {}) {
  const c = { ...DEFAULT_PRIVATE_ACCESS, ...(opts || {}) };
  if (!cachedAt) return true;
  return now - Number(cachedAt) > c.friendListTtlMs;
}

/** 把 OneBot get_friend_list 的结果收敛成 Set（只留 QQ 号字符串）。 */
export function toFriendSet(list) {
  const set = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(item?.user_id ?? item?.userId ?? '').trim();
    if (id) set.add(id);
  }
  return set;
}

export function conversationScopeOf(key) {
  return String(key ?? '').startsWith('group:') ? 'group' : normalizeScope('private');
}
