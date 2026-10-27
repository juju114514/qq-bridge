// 排队消息的**落盘/恢复**（纯函数，便于单测）。
//
// 为什么需要它：DSH 偶尔连不上时，桥接会把消息放进内存队列并回「⏳ 系统服务重启中，消息已排队」。
// 但队列只在内存里 —— 只要桥接被重启（换端口、守护拉起、用户手动重启），**队列就没了**，
// 用户那条消息永久丢失且没有任何提示（2026-10-28 真实发生：一条抖音链接被吞）。
//
// 这一层的职责只有三个，全部是纯函数、无 IO：
//   1) 把 Map 序列化成可落盘的 JSON（带版本号，便于以后迁移）
//   2) 反序列化时**容错**：坏文件/旧版本/字段缺失都不许抛，降级成空队列并说明原因
//   3) 恢复时按年龄与条数剪枝：过期的丢掉，超量的保留最新的
// 真正的读写写在 bridge 里（那里才知道 state 目录与日志）。

export const QUEUE_FILE_VERSION = 1;
/** 默认：排队消息最多留 24 小时（DSH 挂一整天还没好，旧消息也没意义了） */
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 默认：每个会话最多 50 条（与内存里的 QUEUE_MAX 对齐） */
export const DEFAULT_MAX_PER_KEY = 50;

/** 单条消息只保留"能重投"的字段，别把整个对象图存进磁盘。 */
function normalizeItem(item, now) {
  if (!item || typeof item !== 'object') return null;
  const promptText = String(item.promptText ?? '');
  if (!promptText.trim()) return null;
  const out = { promptText, at: Number(item.at) > 0 ? Number(item.at) : now };
  if (item.farewell) out.farewell = true;
  if (item.silent) out.silent = true;
  if (Array.isArray(item.media) && item.media.length) out.media = item.media;
  if (item.wakeReason) out.wakeReason = String(item.wakeReason);
  return out;
}

/**
 * Map<key, item[]> → 可落盘对象。
 * @param {Iterable<[string, object[]]>} entries
 */
export function serializeQueue(entries, { now = Date.now() } = {}) {
  const items = {};
  let count = 0;
  for (const [key, list] of entries ?? []) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const cleaned = list.map((item) => normalizeItem(item, now)).filter(Boolean);
    if (cleaned.length === 0) continue;
    items[String(key)] = cleaned;
    count += cleaned.length;
  }
  return { version: QUEUE_FILE_VERSION, savedAt: now, count, items };
}

/**
 * 落盘对象 → Map + 剪枝统计。**永不抛异常**：坏数据降级成空队列并给出 error 文案。
 * @param {string|object} raw JSON 文本或已解析对象
 * @returns {{entries: Array<[string, object[]]>, restored: number, droppedExpired: number,
 *            droppedOverCap: number, error: string}}
 */
export function deserializeQueue(raw, {
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxPerKey = DEFAULT_MAX_PER_KEY
} = {}) {
  const empty = { entries: [], restored: 0, droppedExpired: 0, droppedOverCap: 0, error: '' };
  let data = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return empty;
    try {
      data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch (error) {
      return { ...empty, error: `队列文件不是合法 JSON（${error?.message ?? error}）` };
    }
  }
  if (!data || typeof data !== 'object') return { ...empty, error: '队列文件内容不是对象' };
  const version = Number(data.version);
  if (version > QUEUE_FILE_VERSION) {
    return { ...empty, error: `队列文件版本 ${version} 比本程序支持的 ${QUEUE_FILE_VERSION} 新，已忽略` };
  }
  const items = data.items;
  if (!items || typeof items !== 'object') return { ...empty, error: '队列文件缺少 items' };

  const entries = [];
  let restored = 0;
  let droppedExpired = 0;
  let droppedOverCap = 0;
  for (const [key, list] of Object.entries(items)) {
    if (!Array.isArray(list)) continue;
    const kept = [];
    for (const item of list) {
      const normalized = normalizeItem(item, now);
      if (!normalized) { droppedExpired += 1; continue; }
      if (normalized.at > now) normalized.at = now; // 未来时间戳（时钟回拨）拉回现在
      if (now - normalized.at > maxAgeMs) { droppedExpired += 1; continue; }
      kept.push(normalized);
    }
    if (kept.length === 0) continue;
    if (kept.length > maxPerKey) {
      droppedOverCap += kept.length - maxPerKey;
      kept.splice(0, kept.length - maxPerKey); // 保留最新的
    }
    entries.push([key, kept]);
    restored += kept.length;
  }
  return { entries, restored, droppedExpired, droppedOverCap, error: '' };
}
