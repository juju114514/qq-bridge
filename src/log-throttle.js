// 日志节流（0.5.43）
//
// 为什么需要：手机上（以及任何长期运行的环境）网关没起来时，桥接会每 1~3 秒重连一次，
// 每次打两三条日志。一小时就是几千行 —— 费电、刷屏，还把所有有用的日志淹掉。
//
// 设计：**按 key 分组**，同一个 key 在窗口内只放第一条，窗口结束时补一条「同类共 N 条」。
// 不做全局限流，因为不同来源的日志本来就该各说各的。
export function createThrottledLogger(log, { windowMs = 60000, now = () => Date.now() } = {}) {
  /** @type {Map<string, {at:number, suppressed:number, last:string}>} */
  const state = new Map();

  return function throttled(key, message) {
    const t = now();
    const cur = state.get(key);
    if (!cur || t - cur.at >= windowMs) {
      // 上一窗口压掉的量，用一条汇总补上（不然用户以为中间什么都没发生）
      if (cur && cur.suppressed > 0) {
        log(`（同类日志在上个窗口内又出现 ${cur.suppressed} 次，已省略）`);
      }
      state.set(key, { at: t, suppressed: 0, last: String(message) });
      log(message);
      return true;
    }
    cur.suppressed += 1;
    return false;
  };
}
