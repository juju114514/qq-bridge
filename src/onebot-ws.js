/**
 * 极简 OneBot v11 WebSocket 客户端（替代 `@snowluma/sdk`）。
 *
 * 为什么要自己写：
 *   `@snowluma/sdk` 的 package.json 声明 `SEE LICENSE IN LICENSE`，但**发布的包里没有
 *   LICENSE 文件**，许可态不可判定；且它住在 SnowLuma 仓库的 `packages/` 下，按 SnowLuma
 *   LICENSE §1 对 "Software" 的定义受那份非商业许可约束。更麻烦的是上游为了让它的 ESM
 *   产物能跑，`postinstall` 会**修改这个包的 dist** —— 那是「程序化修改第三方代码」，
 *   与 SnowLuma 维护者在 K0nd1us/QQ-agent#71 里点名的行为同类。
 *
 *   去掉它之后，本仓库对 SnowLuma 的关系只剩：**读它的 onebot 配置发现 token + 按公开的
 *   OneBot v11 协议通信**，不再依赖、不再修改、不再分发任何 SnowLuma 代码。
 *
 * 兼容性约定：本类的公开方法与事件语义**逐条对齐** SDK 里我们实际用到的那部分
 * （见 docs/design/decisions 与 scripts/test-onebot-ws.mjs 的行为对照测试）：
 *
 *   · 构造：{ url, accessToken, reconnect, requestTimeoutMs }
 *   · 生命周期：connect() / close(code, reason) / isConnected / on('open'|'close'|'error')
 *   · 事件：on / once / off / when / onEvent / onPrivateMessage / onGroupMessage
 *           / onNotice(type?) / onRequest(type?) / onBotStatus / onMetaEvent
 *   · 动作：request()（原始信封）/ call()（成功返回 data，失败抛错）/ raw()
 *           / sendPrivateMessage / sendGroupMessage / sendMsg / getLoginInfo / getStatus
 *           / getVersionInfo / getMessage / getGroupMemberList / getGroupMemberInfo
 *           / getImage / fetchFaceEntity
 *
 * 协议细节（照 SDK 实现抄的，别改）：
 *   · 鉴权走 URL query：`?access_token=...`
 *   · 动作：send({ action, params, echo })，响应靠 `echo` 配对 pending
 *   · 事件：带 `post_type` 的下发包，按 post_type / message_type / notice_type 分发
 *   · 重连：指数退避，minDelayMs 1000 → maxDelayMs 30000，成功连上后重置计数
 */

const WS_OPEN = 1;

/** 一条纯文本消息段。SDK 里 `text()` 的行为就是 `chain().text(value)`。 */
export function text(value = '') {
  return { type: 'text', data: { text: String(value ?? '') } };
}

/** 把 string / 单个消息段 / 消息段数组统一成 OneBot 的 message 字段。 */
export function normalizeMessage(message) {
  if (Array.isArray(message)) return message;
  if (message && typeof message === 'object' && typeof message.type === 'string') return [message];
  if (message && typeof message === 'object' && Array.isArray(message.message)) return message.message;
  return [text(message)];
}

function normalizeReconnect(value) {
  if (value === false || value === null) return null;
  if (value === undefined || value === true) {
    return { retries: Number.POSITIVE_INFINITY, minDelayMs: 1000, maxDelayMs: 30000, factor: 2 };
  }
  if (typeof value === 'object') {
    return {
      retries: value.retries ?? Number.POSITIVE_INFINITY,
      minDelayMs: value.minDelayMs ?? 1000,
      maxDelayMs: value.maxDelayMs ?? 30000,
      factor: value.factor ?? 2,
    };
  }
  return { retries: Number.POSITIVE_INFINITY, minDelayMs: 1000, maxDelayMs: 30000, factor: 2 };
}

function appendAccessToken(url, accessToken) {
  if (!accessToken) return url;
  const u = new URL(url);
  if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', accessToken);
  return u.toString();
}

function toPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 把 WebSocket 的 error 对象/Event 归一成能打日志的东西。
 * 浏览器风格的事件对象上 `message` 常是 undefined，直接透传会打成 `{}`（实测过：
 * 日志里出现「SnowLuma 错误：{}」，排障时等于没有信息）。
 */
function normalizeWsError(error) {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object') {
    if (error.error instanceof Error) return error.error;
    const detail = error.message ?? error.error?.message ?? error.reason;
    if (detail) return new Error(String(detail));
    const code = error.code ?? error.error?.code;
    if (code !== undefined) return new Error(`WebSocket error (code=${code})`);
  }
  if (typeof error === 'string' && error) return new Error(error);
  return new Error('WebSocket error');
}

// ── 事件判定（与 SDK 的 events/guards.js 一一对应）──────────────────────────
export const isMessageEvent = (e) =>
  (e?.post_type === 'message' || e?.post_type === 'message_sent')
  && (e?.message_type === 'private' || e?.message_type === 'group');
export const isPrivateMessageEvent = (e) => isMessageEvent(e) && e.message_type === 'private';
export const isGroupMessageEvent = (e) => isMessageEvent(e) && e.message_type === 'group';
export const isNoticeEvent = (e) => e?.post_type === 'notice' && typeof e.notice_type === 'string';
export const isBotStatusEvent = (e) =>
  isNoticeEvent(e) && e.notice_type === 'bot_status'
  && (e.sub_type === 'online' || e.sub_type === 'offline') && typeof e.user_id === 'number';
export const isRequestEvent = (e) =>
  e?.post_type === 'request' && typeof e.request_type === 'string' && typeof e.flag === 'string';
export const isMetaEvent = (e) => e?.post_type === 'meta_event' && typeof e.meta_event_type === 'string';
export const noticeType = (type) => (e) => isNoticeEvent(e) && e.notice_type === type;
export const requestType = (type) => (e) => isRequestEvent(e) && e.request_type === type;

export class OneBotWsClient {
  constructor(options = {}) {
    this.url = options.url ?? 'ws://127.0.0.1:3001/';
    this.accessToken = options.accessToken;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.protocols = options.protocols;
    this.WebSocketCtor = options.webSocket ?? globalThis.WebSocket;
    this.reconnect = normalizeReconnect(options.reconnect);
    if (!this.WebSocketCtor) throw new Error('No WebSocket implementation is available');

    this.listeners = new Map();      // event -> Set<handler>
    this.predicates = new Set();     // { predicate, handler }
    this.pending = new Map();        // echoKey -> { resolve, reject, timer }
    this.socket = null;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.closedByUser = false;
    this.echoSeq = 0;
  }

  // ── 事件订阅 ─────────────────────────────────────────────────────────────
  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
    return () => this.off(event, listener);
  }

  once(event, listener) {
    const off = this.on(event, (...args) => { off(); listener(...args); });
    return off;
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try { handler(payload); } catch { /* 单个订阅者出错不影响其它 */ }
    }
  }

  /** 注册一个「事件判定通过才回调」的订阅，返回取消函数。 */
  when(predicate, handler) {
    const entry = { predicate, handler };
    this.predicates.add(entry);
    return () => this.predicates.delete(entry);
  }

  onEvent(handler) { return this.on('event', handler); }
  onPrivateMessage(handler) { return this.when(isPrivateMessageEvent, handler); }
  onGroupMessage(handler) { return this.when(isGroupMessageEvent, handler); }
  onMetaEvent(handler) { return this.when(isMetaEvent, handler); }
  onBotStatus(handler) { return this.when(isBotStatusEvent, handler); }
  onNotice(typeOrHandler, handler) {
    if (typeof typeOrHandler === 'string') {
      if (!handler) throw new TypeError('onNotice(type, handler) requires a handler');
      return this.when(noticeType(typeOrHandler), handler);
    }
    return this.when(isNoticeEvent, typeOrHandler);
  }
  onRequest(typeOrHandler, handler) {
    if (typeof typeOrHandler === 'string') {
      if (!handler) throw new TypeError('onRequest(type, handler) requires a handler');
      return this.when(requestType(typeOrHandler), handler);
    }
    return this.when(isRequestEvent, typeOrHandler);
  }

  // ── 连接生命周期 ──────────────────────────────────────────────────────────
  get isConnected() {
    return this.socket?.readyState === WS_OPEN;
  }

  async connect() {
    if (this.isConnected) return;
    if (this.connectPromise) return this.connectPromise;
    this.closedByUser = false;
    this.connectPromise = new Promise((resolve, reject) => {
      const url = appendAccessToken(this.url, this.accessToken);
      let socket;
      try {
        socket = new this.WebSocketCtor(url, this.protocols);
      } catch (error) {
        this.connectPromise = null;
        reject(error);
        return;
      }
      this.socket = socket;
      let settled = false;

      const onOpen = () => {
        this.reconnectAttempts = 0;
        this.connectPromise = null;
        settled = true;
        this.emit('open', undefined);
        resolve();
      };
      const onError = (error) => {
        this.emit('error', normalizeWsError(error));
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          reject(error instanceof Error ? error : new Error(String(error?.message ?? error)));
        }
      };
      const onClose = (...args) => {
        this.handleClose(args);
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          reject(new Error('OneBot WebSocket closed before opening'));
        }
      };
      const onMessage = (event) => {
        this.handleMessage(event?.data ?? event);
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      socket.addEventListener('message', onMessage);
    });
    return this.connectPromise;
  }

  handleMessage(raw) {
    const rawText = typeof raw === 'string' ? raw : String(raw);
    this.emit('raw', rawText);
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      this.emit('error', new Error(`OneBot WebSocket returned non-JSON message: ${error?.message ?? error}`));
      return;
    }
    // 1) 动作响应：有 echo 且命中 pending
    if (parsed && parsed.echo != null && this.pending.has(String(parsed.echo))) {
      const key = String(parsed.echo);
      const entry = this.pending.get(key);
      this.pending.delete(key);
      if (entry?.timer) clearTimeout(entry.timer);
      entry?.resolve(parsed);
      return;
    }
    // 2) 事件：有 post_type
    if (parsed && typeof parsed.post_type === 'string') {
      this.emit('event', parsed);
      for (const { predicate, handler } of [...this.predicates]) {
        let ok = false;
        try { ok = predicate(parsed); } catch { ok = false; }
        if (!ok) continue;
        try { handler(parsed); } catch { /* 单个订阅者出错不影响其它 */ }
      }
      return;
    }
    // 3) 其它（含无 echo 的响应）只广播 raw，避免静默丢弃
    this.emit('unmatched', parsed);
  }

  handleClose(args) {
    const info = { code: args?.[0]?.code ?? args?.[0], reason: args?.[0]?.reason ?? args?.[1] };
    this.socket = null;
    this.connectPromise = null;
    this.rejectPending(new Error('OneBot WebSocket closed'));
    this.emit('close', info);
    if (!this.closedByUser && this.reconnect) this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const cfg = this.reconnect;
    if (!cfg) return;
    if (this.reconnectAttempts >= (cfg.retries ?? Number.POSITIVE_INFINITY)) return;
    const delay = Math.min(
      cfg.maxDelayMs ?? 30000,
      (cfg.minDelayMs ?? 1000) * Math.pow(cfg.factor ?? 2, this.reconnectAttempts),
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => this.emit('error', error));
    }, delay);
    // setTimeout 不该拖住进程退出（Node 下 unref 存在时）
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  rejectPending(error) {
    for (const [, entry] of this.pending) {
      if (entry?.timer) clearTimeout(entry.timer);
      entry?.reject(error);
    }
    this.pending.clear();
  }

  close(code = 1000, reason = 'normal') {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPending(new Error('OneBot WebSocket client closed'));
    try { this.socket?.close(code, reason); } catch { /* 已断开 */ }
    this.socket = null;
    this.connectPromise = null;
  }

  // ── 动作通道 ─────────────────────────────────────────────────────────────
  /** 发送一个 OneBot 动作，返回**原始信封** { status, retcode, data, echo }。 */
  async request(action, params, options = {}) {
    if (options?.signal?.aborted) throw new Error('OneBot request aborted before connection opened');
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) throw new Error('OneBot WebSocket is not open');

    const echo = options?.echo ?? `qqb-${Date.now().toString(36)}-${++this.echoSeq}`;
    const key = String(echo);
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      // 这个 timer **不能 unref**：请求在等响应时本该让进程活着。
      // （实测过：unref 之后，一个只有"等响应"的脚本会直接在超时前退出，
      //  表现为 await 永远不 settle —— 见 scripts/test-onebot-ws.mjs 的超时用例。）
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(key);
          reject(new Error(`OneBot action timed out after ${timeoutMs}ms: ${action}`));
        }, timeoutMs)
        : null;
      this.pending.set(key, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ action, params: toPlainObject(params), echo }));
      } catch (error) {
        this.pending.delete(key);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** 发送动作并在失败时抛错，成功返回 `data`（与 SDK 的 call() 等价）。 */
  async call(action, params, options) {
    const response = await this.request(action, params, options);
    if (response.status !== 'ok' || response.retcode !== 0) {
      const detail = response.wording || response.message || response.status || 'unknown error';
      const error = new Error(`OneBot ${action} failed: retcode=${response.retcode} ${detail}`);
      error.response = response;
      error.retcode = response.retcode;
      throw error;
    }
    return response.data;
  }

  raw(action, params, options) {
    return this.call(action, params, options);
  }

  rawResponse(action, params, options) {
    return this.request(action, params, options);
  }

  // ── 常用动作（只实现本仓库真正用到的那些）─────────────────────────────────
  getLoginInfo(options) { return this.call('get_login_info', {}, options); }
  getStatus(options) { return this.call('get_status', {}, options); }
  getVersionInfo(options) { return this.call('get_version_info', {}, options); }
  getMessage(messageId, options) { return this.call('get_msg', { message_id: messageId }, options); }
  getImage(params, options) { return this.call('get_image', params, options); }
  fetchFaceEntity(faceId, options = {}) {
    return this.call('fetch_face_entity', { face_id: faceId, refresh: options.refresh ?? false }, options);
  }
  getGroupMemberList(groupId, options) {
    return this.call('get_group_member_list', { group_id: groupId }, options);
  }
  getGroupMemberInfo(groupId, userId, options = {}) {
    return this.call('get_group_member_info', {
      group_id: groupId,
      user_id: userId,
      no_cache: options.noCache ?? false,
    }, options);
  }
  sendMsg(params, options) {
    return this.call('send_msg', { ...params, message: normalizeMessage(params?.message) }, options);
  }
  sendPrivateMessage(userId, message, options) {
    return this.call('send_private_msg', { user_id: userId, message: normalizeMessage(message) }, options);
  }
  sendGroupMessage(groupId, message, options) {
    return this.call('send_group_msg', { group_id: groupId, message: normalizeMessage(message) }, options);
  }
}

export default OneBotWsClient;
