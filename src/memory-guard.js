// 记忆护栏（0.4.141）
//
// 背景（真实事故）：2026-10-29 AI 用 qq_memory_append 给群里两个人写了人物印象，工具返回 ok:true；
// 到 11-02 再看，`memberImpressions` 是空的，`state/memory/group_*.md` 也没生成。
// 写入是成功的、清空是没记录的 —— 说明它是被**一次旧快照的整体落盘覆盖**掉的
// （同一天有多次重启 + 删会话备份/调人设等操作）。
//
// 这类丢失最恶劣的地方：**没有任何报错**。所以加一道护栏：
// 落盘前如果发现「内存里这部分是空的，但磁盘上明明有内容」，就把磁盘那份救回来并记一条日志，
// 除非这次清空是操作者/工具显式要求的（allowClearKeys）。
//
// 只有三个字段参与：memberImpressions / activeTopics / pendingThoughts。
// 其余字段（水位、唤醒时间、消息缓存）随时可能合法地变空，不能拦。

export const GUARDED_FIELDS = ['memberImpressions', 'activeTopics', 'pendingThoughts'];

/** 这次清空被显式允许的会话 key（由 /api/socialV2/memory/clear 与 qq_memory_clear 标记） */
const allowClear = new Set();

export function markMemoryClear(key) {
  if (key) allowClear.add(String(key));
}

export function isMemoryClearAllowed(key) {
  return allowClear.has(String(key));
}

/** 清空动作结束后调用：只允许"这一次"落盘，之后的覆盖仍然拦 */
export function consumeMemoryClear(key) {
  return allowClear.delete(String(key));
}

export function resetMemoryClear() {
  allowClear.clear();
}

function isEmptyValue(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function sizeOf(v) {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return 0;
}

/**
 * 纯函数：比较「准备写入的内存态」与「磁盘现状」，把被意外清空的字段救回来。
 *
 * @param {{memory: object, disk: object, allowClearKeys?: Set<string>|string[], isAllowed?: (key:string)=>boolean}} args
 * @returns {{restored: Array<{key: string, field: string, count: number}>, memory: object}}
 */
export function restoreDroppedMemory({ memory, disk, allowClearKeys = [], isAllowed = null } = {}) {
  const allowed = allowClearKeys instanceof Set ? allowClearKeys : new Set(allowClearKeys || []);
  const allow = (key) => allowed.has(key) || (typeof isAllowed === 'function' && isAllowed(key));
  const restored = [];
  if (!memory || typeof memory !== 'object' || !disk || typeof disk !== 'object') {
    return { restored, memory };
  }

  for (const [key, diskSt] of Object.entries(disk)) {
    if (!diskSt || typeof diskSt !== 'object') continue;
    if (allow(key)) continue;                          // 显式清空，放行
    const memSt = memory[key];
    if (!memSt || typeof memSt !== 'object') continue; // 会话被整体删掉是另一回事，不在本护栏范围
    for (const field of GUARDED_FIELDS) {
      const diskVal = diskSt[field];
      const memVal = memSt[field];
      if (!isEmptyValue(diskVal) && isEmptyValue(memVal)) {
        memSt[field] = diskVal;
        restored.push({ key, field, count: sizeOf(diskVal) });
      }
    }
  }
  return { restored, memory };
}
