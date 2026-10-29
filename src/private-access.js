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

// ── 与具体网关解耦（SnowLuma / NapCat 都适用）────────────────────────────
//
// OneBot v11 的私聊事件里：
//   message_type = 'private'
//   sub_type     = 'friend' | 'group' | 'other'
// 其中 'group' 就是**临时会话**（从群聊发起、非好友）。两家实现都遵循这个字段，
// 所以判定不必区分网关。
//
// 唯一差异是 get_friend_list：SnowLuma 不一定实现。所以：
//   · 好友名单拿不到（unknown）→ 只认白名单（fail-closed）
//   · 拿得到 → 按 allowFriends / allowStrangers 判

export function classifyOneBotPrivate(event = {}) {
  const sub = String(event.sub_type ?? event.subType ?? '').toLowerCase();
  const id = String(event.user_id ?? event.userId ?? '').trim();
  return {
    userId: id,
    messageType: String(event.message_type ?? event.messageType ?? '').toLowerCase(),
    subType: sub,
    // 只有 'friend' 算好友私聊；'group' 是群临时会话，其余按陌生处理
    isTemp: sub === 'group' || sub === 'other',
    isFriend: sub === 'friend'
  };
}

/**
 * 从 OneBot 事件直接判定（网关无关）。
 * @param {{enabled?:boolean, allowFriends?:boolean, allowStrangers?:boolean}} opts
 * @param {object} event OneBot 私聊事件
 * @param {{friends?:Set<string>|null, allowList?:string[]}} ctx friends=null 表示网关不支持好友列表
 */
export function decideFromOneBot(opts = {}, event = {}, ctx = {}) {
  const base = classifyOneBotPrivate(event);
  const allowList = Array.isArray(ctx.allowList) ? ctx.allowList.map(String) : [];
  const friends = ctx.friends instanceof Set ? ctx.friends : null;

  // 管理员直通：主人给机器人发私聊必须能收到回复。
  // 真实事故（2026-10-30）：SnowLuma 不实现好友列表 → friends=null → 只认白名单，
  // 而 allow.private 是空的 → 连管理员自己的私聊都被判 not-friend 拒掉，
  // 表现就是"私聊发了没反应"，而且日志里只有一行拒绝，很容易被忽略。
  const ownerQQ = String(ctx.ownerQQ ?? '').trim();
  if (ownerQQ && base.userId === ownerQQ) {
    return { allowed: true, reason: 'owner', userId: base.userId, knownFriends: friends !== null };
  }

  // 好友名单未知（如 SnowLuma 不实现 get_friend_list）：只信白名单
  if (friends === null) {
    if (allowList.includes(base.userId)) return { allowed: true, reason: 'allowlist', userId: base.userId, knownFriends: false };
    return {
      allowed: false,
      reason: base.isTemp ? PRIVATE_DENY.TEMP_SESSION : PRIVATE_DENY.NOT_FRIEND,
      userId: base.userId,
      knownFriends: false,
      hint: '网关不支持好友列表，仅白名单放行（config.allow.private）'
    };
  }

  return decidePrivateAccess(opts, {
    isFriend: friends.has(base.userId) || base.isFriend,
    isTemp: base.isTemp,
    inAllowList: allowList.includes(base.userId),
    userId: base.userId
  });
}

/** 网关能力探测结果 → 提示文案（排障时直接打印）。 */
export function describeGatewayCapability({ hasFriendList } = {}) {
  return hasFriendList
    ? '好友列表可用：按 allowFriends / allowStrangers 判定'
    : '好友列表不可用：仅白名单放行（SnowLuma 常见）';
}
