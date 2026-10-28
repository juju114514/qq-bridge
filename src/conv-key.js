// 会话 key 的**唯一**解析入口：既认 OneBot 的数字 id，也认官方通道的 openid。
//
// 为什么必须统一：官方会话的 key 是 `group:official-<openid>`，而仓库里到处是
// `/^(group|private):(\d+)$/` + `Number(id)`。官方 id 撞上它们会有两种表现：
//
//   1. 直接判"格式非法" → 工具报 "key 格式应为 group:群号 或 private:QQ号"
//   2. 侥幸过格式校验 → Number('official-…') = NaN → 发送到 NaN 群号
//
// 所以这里给出一个共享正则与转换函数，所有发送/读取端点都用它，不再各写一份。

export const OFFICIAL_ID_PREFIX = 'official-';

/** group:<数字> / private:<数字> / group|private:official-<openid> */
export const CONV_KEY_RE = /^(group|private):(\d+|official-[A-Za-z0-9_-]+)$/;

export function isOfficialIdPart(id) {
  return String(id ?? '').startsWith(OFFICIAL_ID_PREFIX);
}

/** 官方 id 原样保留（openid 不是数字）；数字 id 转 Number 并校验为正整数。 */
export function convId(raw) {
  const s = String(raw ?? '');
  if (isOfficialIdPart(s)) return s;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : NaN;
}

/** 解析 key；失败返回 null。 */
export function parseConvKey(key) {
  const m = CONV_KEY_RE.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = convId(m[2]);
  if (typeof id === 'number' && !Number.isFinite(id)) return null;
  return { kind: m[1], id, official: isOfficialIdPart(m[2]) };
}
