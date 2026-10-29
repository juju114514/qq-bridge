// 静默时段：夜间不主动搭话（消息照常记录，只是不唤醒模型）。
//
// 为什么单独一个模块：
//   时间区间判断看着简单，坑全在边界上 —— 跨零点（23→8）、start===end、
//   时区偏移、跨天数。做成纯函数才能把这些用测试钉死，而不是等半夜才发现。
//
// 配置：config.socialV2.quietHours = [23, 8] 表示 23:00 ~ 次日 08:00
//       null 或 [x, x] 表示关闭。

/** 把配置值规范化成 [start, end] 或 null（非法/关闭）。 */
export function parseQuietHours(raw) {
  if (raw === null || raw === undefined || raw === false) return null;
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new TypeError('socialV2.quietHours 需要两个 0~23 的整数，或 null 关闭');
  }
  const [start, end] = raw.map(Number);
  for (const n of [start, end]) {
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      throw new TypeError('socialV2.quietHours 需要两个 0~23 的整数，或 null 关闭');
    }
  }
  if (start === end) return null;      // 同时刻 = 关闭，不给"静默 24 小时"的意外
  return [start, end];
}

/**
 * 当前是否处于静默时段。
 * @param {number} now 毫秒时间戳
 * @param {[number, number]|null} range parseQuietHours 的结果
 * @param {{offsetMin?:number}} opts offsetMin = 相对 UTC 的分钟偏移（东八区 = 480）
 */
export function inQuietHours(now, range, opts = {}) {
  if (!range) return false;
  const [start, end] = range;
  // 默认用本机时区；显式传 offsetMin 便于测试（不依赖跑测试机器的时区）
  const offsetMin = Number.isFinite(opts.offsetMin)
    ? Number(opts.offsetMin)
    : -new Date(now).getTimezoneOffset();
  const localMs = Number(now) + offsetMin * 60 * 1000;
  const hour = new Date(localMs).getUTCHours();
  if (start < end) return hour >= start && hour < end;   // 同一天内，如 13~15
  return hour >= start || hour < end;                     // 跨零点，如 23~8
}

/** 给日志/提示用的一句话。 */
export function describeQuietHours(range) {
  if (!range) return '未启用静默时段';
  const [s, e] = range;
  return `静默时段 ${String(s).padStart(2, '0')}:00 ~ ${String(e).padStart(2, '0')}:00`;
}

/** 静默时段内不该触发的唤醒原因（管理员指令与引导除外）。 */
export const QUIET_OVERRIDE_REASONS = Object.freeze(['admin', 'bootstrap']);
export function shouldSilenceWake(reason) {
  const base = String(reason ?? '').split(':')[0];
  return !QUIET_OVERRIDE_REASONS.includes(base);
}