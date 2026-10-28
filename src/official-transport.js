// 官方通道与桥接之间的**适配层**：ID 命名、事件合成、发送路由。
//
// 为什么需要它：桥接内部到处是 `key = kind:id`、id 当 QQ 号用（`Number(id)`），
// 而官方通道给的是 **openid**（不透明字符串，不是 QQ 号），两者绝不能混。
// 这里用**前缀**把它们隔开：官方会话的 id 一律是 `official-<openid>`，
// 于是 `kind` 仍是 group/private（权限、模式、人格那些逻辑一行都不用改），
// 只有"发消息"与"白名单"两处需要识别前缀。
//
// 纯函数优先：ID 处理、事件合成都能离线测；只有 start/send 碰网络。

import { OfficialQqBot } from './qqbot-official.js';

export const OFFICIAL_ID_PREFIX = 'official-';
/** 被动回复窗口：官方是 5 分钟，这里留 30 秒余量，超了就改发主动消息 */
export const PASSIVE_WINDOW_MS = 4.5 * 60 * 1000;

export function isOfficialId(id) {
  return String(id ?? '').startsWith(OFFICIAL_ID_PREFIX);
}

export function officialId(openid) {
  return `${OFFICIAL_ID_PREFIX}${String(openid ?? '')}`;
}

export function stripOfficialId(id) {
  const s = String(id ?? '');
  return s.startsWith(OFFICIAL_ID_PREFIX) ? s.slice(OFFICIAL_ID_PREFIX.length) : s;
}

/**
 * 官方事件 → 桥接内部的 OneBot 形状事件。
 *
 * 关键取舍：`group_id` / `user_id` 用 `official-<openid>`，`self_id` 留空
 * （这样"自己发的消息"防回环逻辑不会误判），并把原始信息挂在 `__official` 上。
 */
export function toOneBotEvent(event) {
  if (!event) return null;
  const id = officialId(event.id);
  const isGroup = event.kind === 'group';
  return {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    ...(isGroup ? { group_id: id } : { user_id: id }),
    user_id: isGroup ? id : id,
    self_id: '',
    message_id: event.msgId,
    raw_message: event.text,
    message: [{ type: 'text', data: { text: event.text } }],
    sender: {
      user_id: isGroup ? officialId(event.authorId) : id,
      nickname: event.authorName
    },
    time: Math.floor((event.timestamp || Date.now() / 1000)),
    __official: {
      transport: 'official',
      kind: event.kind,
      openid: event.id,
      msgId: event.msgId,
      atBot: event.atBot,
      attachments: event.attachments
    }
  };
}

/**
 * 把桥接的 OneBot 消息段**降级**成官方通道能发的纯文本。
 * 官方文本消息只吃 `content`，没有 CQ 码；@/图片/语音/表情都要单独处理。
 * 返回 { text, unsupported: string[] }，调用方决定"丢弃并说明"还是"直接报错"。
 */
export function segmentsToOfficialText(segments) {
  const parts = [];
  const unsupported = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const type = seg?.type;
    if (type === 'text') { parts.push(String(seg?.data?.text ?? '')); continue; }
    if (type === 'at') {
      const qq = String(seg?.data?.qq ?? '');
      parts.push(qq === 'all' ? '@全体成员' : `@${seg?.data?.name ?? qq}`);
      continue;
    }
    if (type === 'reply') continue; // 官方用 msg_id 表达引用，不放进正文
    unsupported.push(String(type));
  }
  return { text: parts.join('').trim(), unsupported };
}

/**
 * 官方通道适配器。
 *
 * @param {{
 *   appid:string, secret:string, sandbox?:boolean, log?:(m:string)=>void,
 *   allowAll?:boolean, allow?:string[], intents?:number
 * }} opts
 */
export function createOfficialTransport(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const bot = new OfficialQqBot({
    appid: opts.appid, secret: opts.secret, sandbox: opts.sandbox, intents: opts.intents, log
  });
  /** id → { msgId, at }：用于判断还能不能走被动回复 */
  const lastInbound = new Map();
  let started = false;

  const allowAll = opts.allowAll === true;
  const allowList = new Set((Array.isArray(opts.allow) ? opts.allow : []).map((x) => String(x).replace(/^official-/, '')));

  /** 白名单：官方会话按 openid 判断（与 allow.groups 的数字 QQ 号完全分开）。 */
  function allowed(kind, id) {
    const openid = stripOfficialId(id);
    if (!openid) return false;
    if (allowAll) return true;
    if (allowList.has(openid)) return true;
    // 兼容把官方会话直接写进 allow.groups/allow.private 的写法
    if ((kind === 'group' ? opts.legacyGroups : opts.legacyPrivates)?.includes?.(String(id))) return true;
    return false;
  }

  function rememberInbound(event) {
    if (!event?.id) return;
    lastInbound.set(officialId(event.id), { msgId: event.msgId, at: Date.now() });
    if (lastInbound.size > 200) {
      const first = lastInbound.keys().next().value;
      lastInbound.delete(first);
    }
  }

  /**
   * 发文本。能被动回复就带 msg_id（5 次上限由 OfficialQqBot 内部计数），
   * 否则退回主动消息（可能因用户关闭"允许主动发送"而失败，错误原样抛给调用方）。
   */
  async function sendText(kind, id, text, opts = {}) {
    const openid = stripOfficialId(id);
    if (!openid) throw new Error(`官方通道发送失败：id 里没有 openid（${id}）`);
    const target = lastInbound.get(officialId(openid));
    // opts.proactive = 主动消息：**强制**不带 msg_id（哪怕还在 5 分钟窗口内），
    // 用于控制台手动播报/定时播报；否则按窗口自动选被动或主动。
    const mayPassive = !opts.proactive && target && Date.now() - target.at <= PASSIVE_WINDOW_MS;
    const msgId = mayPassive ? target.msgId : '';
    if (kind === 'group') return bot.sendGroupText(openid, text, { msgId });
    return bot.sendC2CText(openid, text, { msgId });
  }

  return {
    bot,
    allowed,
    sendText,
    rememberInbound,
    stripOfficialId,
    isOfficialId,

    get ready() { return bot.ready; },

    /** 连上去收事件；每条消息都经 onMessage 回调（已是 OneBot 形状）。 */
    async start({ onMessage } = {}) {
      if (started) return bot;
      started = true;
      await bot.connect({
        onReady: () => log('[official] 已就绪，开始收群/单聊消息'),
        onError: (e) => log(`[official] 错误：${e.message}`),
        onEvent: (event) => {
          rememberInbound(event);
          log(`[official] 收到 ${event.kind === 'group' ? '群' : '单聊'}消息（作者 ${event.authorName || '?'}）`);
          try { onMessage?.(event, toOneBotEvent(event)); } catch (e) { log(`[official] 转交失败：${e?.message ?? e}`); }
        }
      });
      return bot;
    },

    close() { bot.close(); }
  };
}
