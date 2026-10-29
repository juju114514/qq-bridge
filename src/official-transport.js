// 官方通道与桥接之间的**适配层**：ID 命名、事件合成、发送路由。
//
// 为什么需要它：桥接内部到处是 `key = kind:id`、id 当 QQ 号用（`Number(id)`），
// 而官方通道给的是 **openid**（不透明字符串，不是 QQ 号），两者绝不能混。
// 这里用**前缀**把它们隔开：官方会话的 id 一律是 `official-<openid>`，
// 于是 `kind` 仍是 group/private（权限、模式、人格那些逻辑一行都不用改），
// 只有"发消息"与"白名单"两处需要识别前缀。
//
// 纯函数优先：ID 处理、事件合成都能离线测；只有 start/send 碰网络。

import fs from 'node:fs';
import { OfficialQqBot } from './qqbot-official.js';
import { checkImageForOfficial, OFFICIAL_FILE_TYPE } from './official-media.js';

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
    // 官方入站的图片在 attachments 里（不是 message 段）。这里补成 image 段：
    //   · 下游 segmentsToText 会产出「[图片]」，模型才知道"有人发了图"，而不是"空的 @"
    //   · url 留在 data 里，后续要下载/看图时能直接用
    message: [
      ...(Array.isArray(event.attachments) ? event.attachments : [])
        .filter((a) => /image/i.test(String(a?.content_type ?? a?.type ?? '')) || a?.url)
        .map((a) => ({ type: 'image', data: { url: String(a.url ?? ''), summary: String(a.filename ?? '') } })),
      { type: 'text', data: { text: event.text } }
    ],
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
 * 判断能否走被动回复（带 msg_id）。
 * 抽成纯函数是为了可测：这一段一旦判错，要么被官方拒（超窗口），
 * 要么把本该主动的消息伪装成被动（占不到正确配额）。
 *
 * @param {{msgId:string, at:number}|undefined} target 最近一次入站记录
 * @param {{now?:number, proactive?:boolean, windowMs?:number}} opts
 */
export function shouldUsePassiveWindow(target, opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const windowMs = Number(opts.windowMs ?? PASSIVE_WINDOW_MS);
  if (opts.proactive === true) return false;          // 主动消息强制不带 msg_id
  if (!target || !target.msgId) return false;
  return now - Number(target.at ?? 0) <= windowMs;
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
    const rec = { kind: event.kind, openid: event.id, msgId: event.msgId, at: Date.now() };
    lastInbound.set(officialId(event.id), { msgId: event.msgId, at: rec.at });
    if (lastInbound.size > 200) {
      const first = lastInbound.keys().next().value;
      lastInbound.delete(first);
    }
    // 落盘最近一条：探针/排障需要 msgId 才能走"被动回复"（主动消息很多机器人无权限）
    try {
      if (opts.inboundFile) fs.writeFileSync(opts.inboundFile, JSON.stringify(rec) + '\n', 'utf8');
    } catch { /* 落盘失败不影响收消息 */ }
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
    const msgId = shouldUsePassiveWindow(target, { proactive: opts.proactive }) ? target.msgId : '';
    if (kind === 'group') return bot.sendGroupText(openid, text, { msgId });
    // wakeup：互动召回消息（只有单聊支持；群里发会被官方拒）
    return bot.sendC2CText(openid, text, { msgId, wakeup: opts.wakeup === true });
  }

  /**
   * 发图片。**上传与发送必须紧挨着**：file_info 带 ttl（真机实测 86400 秒=24h，文档示例写 300），
   * 缓存复用会拿到过期凭证。
   *
   * @param {'group'|'private'} kind
   * @param {string} id `official-<openid>` 或裸 openid
   * @param {Buffer} imageBuffer 图片字节（png/jpg 最稳；gif/webp 官方文档说法不一致）
   * @param {{proactive?:boolean, wakeup?:boolean, content?:string, fileName?:string}} opts
   */
  async function sendImage(kind, id, imageBuffer, opts = {}) {
    const openid = stripOfficialId(id);
    if (!openid) throw new Error(`官方通道发图失败：id 里没有 openid（${id}）`);

    const check = checkImageForOfficial(imageBuffer);
    if (!check.ok) throw new Error(`官方通道发图失败：${check.reason}`);

    const target = lastInbound.get(officialId(openid));
    const passive = shouldUsePassiveWindow(target, { proactive: opts.proactive });
    const msgId = passive ? target.msgId : '';
    // msg_seq 必须**递增且不重复**：官方同一 msg_id 最多回 5 条，重复序号直接 400
    // （真机踩过：文本回复用掉 seq=1 后，发图用 1 会被判"消息被去重"）
    const msgSeq = passive && msgId ? bot.seqTracker.next(msgId) : null;
    if (passive && msgId && msgSeq === null) {
      // 被动次数用完：退回主动消息（多数机器人无权限，但让上层看到真实错误比静默失败好）
      opts = { ...opts, proactive: true };
    }
    const fileName = String(opts.fileName ?? '').trim()
      || `image-${Date.now()}.${check.mime === 'image/png' ? 'png' : 'jpg'}`;

    const up = await bot.uploadMedia(kind === 'group' ? 'group' : 'user', openid, {
      buffer: imageBuffer, fileType: OFFICIAL_FILE_TYPE.image, fileName
    });

    // 立刻发：不要在这里做任何 await 之外的耗时操作（ttl 很短）
    const useMsgId = opts.proactive === true ? '' : msgId;
    const useSeq = opts.proactive === true ? 0 : (msgSeq ?? 0);
    if (kind === 'group') {
      return bot.sendGroupMedia(openid, up.fileInfo, { msgId: useMsgId, msgSeq: useSeq, content: opts.content ?? '' });
    }
    return bot.sendC2CMedia(openid, up.fileInfo, {
      msgId: useMsgId, msgSeq: useSeq, content: opts.content ?? '', wakeup: opts.wakeup === true
    });
  }

  return {
    bot,
    allowed,
    sendText,
    sendImage,
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
          {
            const atts = Array.isArray(event.attachments) ? event.attachments : [];
            const types = atts.map((a) => String(a?.content_type ?? a?.type ?? '?')).join(',') || '无';
            log(`[official] 收到 ${event.kind === 'group' ? '群' : '单聊'}消息（作者 ${event.authorName || '?'}，文本 ${String(event.text ?? '').length} 字，附件 ${atts.length} 个：${types}）`);
          }
          try { onMessage?.(event, toOneBotEvent(event)); } catch (e) { log(`[official] 转交失败：${e?.message ?? e}`); }
        }
      });
      return bot;
    },

    close() { bot.close(); }
  };
}
