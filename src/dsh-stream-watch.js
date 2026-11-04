// DSH 事件流的"静默 0 帧"看门狗（0.5.62）
//
// 真实事故（2026-11-05）：配置里 dsh.baseUrl 指向 127.0.0.1:9230，
// 那个端口上确实有 HTTP 服务在听（访问 `/` 返回 404），于是桥接"连上了"，
// 但每次事件流都立刻结束、收到 0 帧 —— 日志只刷「事件流已结束（本次收到 0 帧）」，
// 看起来像 DSH 版本不兼容，实际是**连错了端口**。
//
// 这个模块只做计数与措辞：连续 N 次 0 帧就明确提示"这个端口可能不是 DSH"。

export const ZERO_FRAME_HINT_THRESHOLD = 3;

let zeroStreak = 0;
let lastFrames = 0;

/**
 * 记录一次事件流结束，返回给日志用的补充说明（没有就返回空串）。
 * @param {number} frames 本次收到的帧数
 * @param {{threshold?:number, baseUrl?:string}} [opts]
 * @returns {string}
 */
export function noteStreamEnd(frames, opts = {}) {
  const n = Number(frames) || 0;
  lastFrames = n;
  if (n > 0) {
    zeroStreak = 0;
    return '';
  }
  zeroStreak += 1;
  const threshold = Number(opts.threshold) || ZERO_FRAME_HINT_THRESHOLD;
  if (zeroStreak < threshold) return '';
  const where = opts.baseUrl ? ` ${opts.baseUrl}` : '';
  return `\n   ⚠️ 连续 ${zeroStreak} 次一个事件帧都没收到：${where} 上可能有别的 HTTP 服务在听，`
    + '但并不提供 DSH 事件流。请确认 dsh.baseUrl 指向 DSH 当前的端口（DSH 每次启动都会换），'
    + '或在控制台「接入与登录」页点「探测端口」。';
}

/** 测试用：重置计数 */
export function resetStreamWatch() {
  zeroStreak = 0;
  lastFrames = 0;
}

/** 当前状态（诊断用） */
export function streamWatchState() {
  return { zeroStreak, lastFrames };
}
