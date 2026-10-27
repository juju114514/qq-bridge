// 可注入的假 WebSocket（只给 scripts/test-onebot-ws.mjs 用）。
//
// 目标：把 OneBot 协议层的语义（echo 配对、事件分发、断线重连）在**不连网**的前提下
// 钉死。真实 WebSocket 是全局对象，测试里换成这个假实现即可。

import { OneBotWsClient } from '../../src/onebot-ws.js';

class FakeWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closed = null;
    this.__listeners = new Map();
    // 立刻异步触发 open（模拟连接建立）
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1; // OPEN
      this.__emit('open', {});
    });
  }

  addEventListener(type, handler) {
    if (!this.__listeners.has(type)) this.__listeners.set(type, new Set());
    this.__listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.__listeners.get(type)?.delete(handler);
  }

  __emit(type, payload) {
    for (const handler of [...(this.__listeners.get(type) ?? [])]) handler(payload);
  }

  send(data) {
    this.sent.push(String(data));
  }

  close(code = 1000, reason = 'normal') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this.__emit('close', { code, reason });
  }

  // 测试辅助：服务端主动断开
  __serverClose(code = 1006, reason = 'abnormal') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this.__emit('close', { code, reason });
  }

  // 测试辅助：服务端下发一帧
  __push(data) {
    this.__emit('message', { data });
  }
}

export function createOneBotWsClientForTest(options = {}) {
  const sockets = [];
  const client = new OneBotWsClient({
    url: 'ws://127.0.0.1:3001/',
    ...options,
    webSocket: class extends FakeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        sockets.push(this);
      }
    },
  });

  const latest = () => sockets[sockets.length - 1];

  return {
    client,
    sockets,
    lastUrl: () => latest()?.url,
    lastSent: () => latest()?.sent[latest().sent.length - 1],
    sentAt: (i) => latest()?.sent[i],
    reply: (payload) => latest()?.__push(JSON.stringify(payload)),
    push: (event) => latest()?.__push(JSON.stringify(event)),
    pushRaw: (raw) => latest()?.__push(raw),
    serverClose: (code, reason) => latest()?.__serverClose(code, reason),
  };
}

export const onebotWsInternals = { FakeWebSocket };
