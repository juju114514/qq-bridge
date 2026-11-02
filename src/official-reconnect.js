// 官方通道的重连策略（0.4.129）
//
// 从 qqbot-official.js 抽出来：那边已到体积上限，而这段是**纯逻辑**（无 IO），
// 放这里既好单测，也让连接类只留三行接线。
//
// 为什么需要：腾讯每小时会发 op 7 / 4009 关连接；以前 close 只打日志，通道就此死掉。

/** 指数退避：1s、2s、4s、8s、16s，封顶 30s，±20% 抖动 */
export function officialReconnectDelay(attempt, { base = 1000, cap = 30000, jitter = 0.2 } = {}) {
  const raw = Math.min(cap, base * Math.pow(2, Math.max(0, Number(attempt) || 0)));
  const delta = raw * jitter;
  return Math.max(500, Math.round(raw - delta + Math.random() * delta * 2));
}

/**
 * 重连状态机：只管「该不该重连 / 第几次 / 定时器」，不碰 WebSocket。
 * @param {{log?:Function, connect:()=>Promise<any>, setTimeoutImpl?:Function, clearTimeoutImpl?:Function}} opts
 */
export function createReconnector({ log = () => {}, connect, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  let attempt = 0;
  let timer = null;
  let stopped = false;

  return {
    get attempt() { return attempt; },
    get stopped() { return stopped; },
    get timer() { return timer; },
    /** 连上后归零 */
    reset() { attempt = 0; },
    /** 连接关闭时调用；返回这次用的延迟（毫秒），已停止/已被取代则返回 null */
    onClose({ unexpected = true } = {}) {
      if (stopped || !unexpected) return null;
      const delay = officialReconnectDelay(attempt);
      attempt += 1;
      clearTimeoutImpl(timer);
      timer = setTimeoutImpl(() => {
        Promise.resolve()
          .then(connect)
          .catch((err) => { log(`[official] 重连失败：${err?.message ?? err}`); this.onClose({ unexpected: true }); });
      }, delay);
      timer?.unref?.();
      return delay;
    },
    stop() { stopped = true; clearTimeoutImpl(timer); timer = null; },
  };
}
