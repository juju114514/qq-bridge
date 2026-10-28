// QQ 官方机器人（q.qq.com · QQ Bot）客户端：拿 token → 连 gateway → 收事件 → 发消息。
//
// 为什么单独一个模块：官方 Bot 与 SnowLuma（个人号 OneBot）是**两套完全不同的协议**：
//   · 鉴权：AppID + AppSecret → access_token（不是 accessToken/扫码）
//   · 传输：WebSocket gateway（op 10 HELLO → op 2 IDENTIFY → op 0 DISPATCH），要心跳与 resume
//   · 身份：事件里只有 group_openid / member_openid，**没有 QQ 号**
//   · 回复：必须带触发消息的 `msg_id`（被动回复），同一条消息最多 5 次（用 msg_seq 递增）
// 把它做成独立模块，桥接那边只负责"把事件翻成内部形状 / 把回复路由过来"。
//
// 文档：https://bot.q.qq.com/wiki/develop/api-v2/

const PROD_API = 'https://api.sgroup.qq.com';
const SANDBOX_API = 'https://sandbox.api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

/** 群聊 @ 与单聊消息的事件订阅位（GROUP_AND_C2C_EVENT） */
export const INTENT_GROUP_AND_C2C = 1 << 25;

/** 去掉消息里的 @机器人 占位符与首尾空白。纯函数。 */
export function stripMention(content) {
  return String(content ?? '')
    .replace(/<@!?[^>]*>/g, '')      // 官方把 @ 渲染成 <@!123> / <@123>
    .replace(/^[\s\u00a0]+/, '')
    .trim();
}

/**
 * 把 gateway 的 DISPATCH 事件翻成"与 OneBot 形状接近"的内部事件。
 *
 * 约定：
 *   · kind = 'group' | 'private'
 *   · id   = group_openid / user_openid（**不是 QQ 号**，见文件头的说明）
 *   · text = 去掉 @占位符后的正文
 * 不是消息事件时返回 null。
 */
export function toBridgeEvent(t, d) {
  if (!d || typeof d !== 'object') return null;
  if (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE') {
    const openid = String(d.group_openid ?? '');
    if (!openid) return null;
    return {
      transport: 'official',
      kind: 'group',
      id: openid,
      text: stripMention(d.content),
      msgId: String(d.id ?? ''),
      msgSeq: 0,
      authorId: String(d.author?.member_openid ?? ''),
      authorName: String(d.author?.username ?? d.author?.member_openid ?? ''),
      atBot: t === 'GROUP_AT_MESSAGE_CREATE',
      timestamp: Number(d.timestamp) || 0,
      attachments: Array.isArray(d.attachments) ? d.attachments : [],
      raw: d
    };
  }
  if (t === 'C2C_MESSAGE_CREATE') {
    const openid = String(d.author?.user_openid ?? '');
    if (!openid) return null;
    return {
      transport: 'official',
      kind: 'private',
      id: openid,
      text: stripMention(d.content),
      msgId: String(d.id ?? ''),
      msgSeq: 0,
      authorId: openid,
      authorName: String(d.author?.username ?? openid),
      atBot: true,
      timestamp: Number(d.timestamp) || 0,
      attachments: Array.isArray(d.attachments) ? d.attachments : [],
      raw: d
    };
  }
  return null;
}

/**
 * 被动回复的 msg_seq 计数：同一 msg_id 最多 5 次（官方限制），超过就返回 null，
 * 让调用方降级成"合并成一条"而不是撞墙。
 */
export class ReplySeqTracker {
  constructor(max = 5) { this.max = max; this.map = new Map(); }

  next(msgId) {
    const key = String(msgId ?? '');
    if (!key) return null;
    const used = this.map.get(key) ?? 0;
    if (used >= this.max) return null;
    const seq = used + 1;
    this.map.set(key, seq);
    // 只留最近 500 条，避免无限增长
    if (this.map.size > 500) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
    return seq;
  }
}

export class OfficialQqBot {
  constructor(opts = {}) {
    this.appid = String(opts.appid ?? '').trim();
    this.secret = String(opts.secret ?? '').trim();
    this.sandbox = opts.sandbox === true;
    this.intents = Number(opts.intents) || INTENT_GROUP_AND_C2C;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.api = this.sandbox ? SANDBOX_API : PROD_API;
    this.token = '';
    this.tokenExpiresAt = 0;
    this.ws = null;
    this.seq = null;
    this.heartbeat = null;
    this.sessionId = '';
    this.ready = false;
    this.seqTracker = new ReplySeqTracker();
  }

  /** 取 access_token（提前 60 秒刷新，失败抛错而不是返回空串）。 */
  async accessToken(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.appid, clientSecret: this.secret }),
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 保留原文 */ }
    if (!res.ok || !data?.access_token) {
      throw new Error(`获取 access_token 失败：HTTP ${res.status} ${String(text).slice(0, 160)}`);
    }
    this.token = String(data.access_token);
    this.tokenExpiresAt = Date.now() + (Number(data.expires_in) || 7200) * 1000;
    return this.token;
  }

  async gateway() {
    const token = await this.accessToken();
    const res = await fetch(`${this.api}/gateway`, {
      headers: { authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`获取 gateway 失败：HTTP ${res.status} ${String(text).slice(0, 160)}`);
    const url = JSON.parse(text)?.url;
    if (!url) throw new Error('gateway 响应里没有 url');
    return String(url);
  }

  /**
   * 连上去并持续收事件。
   * @param {{onEvent:(e:object)=>void, onReady?:()=>void, onError?:(e:Error)=>void}} handlers
   */
  async connect(handlers = {}) {
    if (typeof WebSocket !== 'function') throw new Error('当前 node 没有全局 WebSocket（需要 node ≥ 22）');
    const url = await this.gateway();
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => this.log('[official] WebSocket 已连接'));
    ws.addEventListener('error', (e) => handlers.onError?.(new Error(`WebSocket 错误：${e?.message ?? 'unknown'}`)));
    ws.addEventListener('close', (e) => {
      this.ready = false;
      clearInterval(this.heartbeat);
      this.log(`[official] WebSocket 关闭 code=${e.code} reason=${e.reason || '-'}`);
    });
    ws.addEventListener('message', (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }
      this._handle(payload, handlers);
    });
    return ws;
  }

  _send(obj) {
    try { this.ws?.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }

  async _handle({ op, t, d, s }, handlers) {
    if (s) this.seq = s;
    if (op === 10) {
      const interval = Number(d?.heartbeat_interval) || 30000;
      // 断线续连优先：有 session_id + 上次 seq 就 RESUME，否则 IDENTIFY
      if (this.sessionId && this.seq) {
        this._send({ op: 6, d: { token: `QQBot ${await this.accessToken()}`, session_id: this.sessionId, seq: this.seq } });
      } else {
        this._send({ op: 2, d: { token: `QQBot ${await this.accessToken()}`, intents: this.intents, shard: [0, 1] } });
      }
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this._send({ op: 1, d: this.seq }), interval);
      this.heartbeat.unref?.();
      return;
    }
    if (op === 11) return; // 心跳 ACK
    if (op === 9) { handlers.onError?.(new Error('intents 无效（op 9），检查机器人权限')); return; }
    if (op === 7) { this.log('[official] 服务端要求重连（op 7）'); try { this.ws?.close(); } catch { } return; }
    if (op !== 0) return;

    if (t === 'READY') {
      this.ready = true;
      this.sessionId = String(d?.session_id ?? '');
      this.log(`[official] 鉴权成功：${d?.user?.username ?? '?'}`);
      handlers.onReady?.();
      return;
    }
    if (t === 'RESUMED') { this.ready = true; this.log('[official] 会话已恢复'); return; }

    const event = toBridgeEvent(t, d);
    if (event) handlers.onEvent?.(event);
  }

  async _post(pathName, body) {
    const token = await this.accessToken();
    const res = await fetch(`${this.api}${pathName}`, {
      method: 'POST',
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* ignore */ }
    if (!res.ok) {
      const detail = data?.message || data?.code || String(text).slice(0, 160);
      throw new Error(`发送失败：HTTP ${res.status} ${detail}`);
    }
    return data ?? {};
  }

  /** 群聊文本。传 msgId 就是被动回复（5 分钟内、最多 5 条），不传就是主动消息（有频控）。 */
  async sendGroupText(groupOpenid, content, { msgId = '', msgSeq = 0 } = {}) {
    const body = { content: String(content ?? ''), msg_type: 0 };
    if (msgId) { body.msg_id = String(msgId); body.msg_seq = Number(msgSeq) || 1; }
    return this._post(`/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, body);
  }

  /** 单聊文本，语义同上。 */
  async sendC2CText(userOpenid, content, { msgId = '', msgSeq = 0 } = {}) {
    const body = { content: String(content ?? ''), msg_type: 0 };
    if (msgId) { body.msg_id = String(msgId); body.msg_seq = Number(msgSeq) || 1; }
    return this._post(`/v2/users/${encodeURIComponent(userOpenid)}/messages`, body);
  }

  /**
   * 统一入口：按事件的 kind 选群聊/单聊，并自动分配 msg_seq。
   * @param {{kind:string,id:string,msgId?:string}} event 触发回复的那条事件
   */
  async reply(event, content) {
    const msgSeq = event?.msgId ? this.seqTracker.next(event.msgId) : null;
    if (event?.msgId && msgSeq === null) {
      throw new Error('这条消息的被动回复次数已用完（官方上限 5 次），请合并成一条');
    }
    if (event.kind === 'group') return this.sendGroupText(event.id, content, { msgId: event.msgId, msgSeq });
    return this.sendC2CText(event.id, content, { msgId: event.msgId, msgSeq });
  }

  close() {
    clearInterval(this.heartbeat);
    this.ready = false;
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
