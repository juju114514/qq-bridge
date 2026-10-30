// 运行时（rt）：**共享状态的唯一来源**。
//
// 为什么要有这个文件（出自 docs/ARCHITECTURE.md §2/§3）：
// `bridge.js` 的 main() 是一个 9 千行的函数，262 个函数共享同一个隐式闭包。
// 结果是"改一个判定要读一万行"，而且**没人说得清某个状态归谁** ——
// 之前拆分反复卡住，根因就是这个。
//
// 三个显式接缝：
//   1. rt            —— 所有共享状态的唯一来源（本文件）
//   2. rt.events     —— 跨域只发事件，不互相 import
//   3. 路由表/工具表 —— 对外接口按表注册（波次 4 才做）
//
// 硬规矩：任何**可变计数器**（网关重连、无行动计数…）只能放在 rt.counters。
// 昨晚的问题就是"这个状态归谁"没有唯一答案。

/** 极简事件总线：够用就好，不引入第三方依赖。 */
export function createEmitter() {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    off(name, fn) { handlers.get(name)?.delete(fn); },
    emit(name, payload) {
      const set = handlers.get(name);
      if (!set || set.size === 0) return 0;
      let delivered = 0;
      for (const fn of [...set]) {
        try { fn(payload); delivered += 1; }
        catch (error) { this.lastError = error; }   // 一个监听器炸了不能拖垮其它监听器
      }
      return delivered;
    },
    clear() { handlers.clear(); },
    count(name) { return handlers.get(name)?.size ?? 0; }
  };
}

/**
 * @param {{ cfg?: object, log?: Function, fs?: object, path?: object }} deps
 */
export function createRuntime({ cfg = {}, log = () => {}, fs = null, path = null } = {}) {
  const events = createEmitter();
  return {
    cfg,
    log,
    fs,
    path,

    // 会话映射（key -> sessionId 等）
    state: {
      sessions: {},
      sessionPolicies: {},
      offline: {}
    },

    // 一代/普通模式的社交状态
    social: {
      states: new Map(),
      recentMessages: new Map(),
      silentTurns: new Map(),
      pendingTimers: new Map(),
      exitingSessions: new Set()
    },

    // 二代仿真（reserved2）的会话状态
    socialV2: {
      conversations: new Map(),
      paused: false
    },

    // 消息队列（prompt 排队 / 发送排队）
    queues: {
      pending: new Map(),
      queued: new Map()
    },

    // 传输层：依赖倒置 —— 运行时只持有引用，不自己建连接
    clients: {
      api: null,
      bot: null
    },

    events,

    // 可变计数器唯一归属
    counters: {
      gatewayReconnects: 0,
      wakePromptsSent: 0,
      snapshotsTaken: 0
    }
  };
}