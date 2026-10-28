// 待判表情队列：把"刚收到的表情/图片"先挂起来，交给 AI 自己判断。
//
// 为什么不做本地视觉分类：
//   每张图一次视觉调用太贵，而且群里 90% 的表情没人关心。
//   更好的做法是把"新来了一张图"摆到 AI 面前，让它自己决定要不要看、要不要收。
//
// 约束：
//   · 按 scope 分开存（group / private），群聊的绝不喂给私聊
//   · 每个 scope 最多 PENDING_MAX 条，先进先出
//   · 只存 id + 时间 + 来源，不存图片内容（避免内存膨胀）

export const PENDING_MAX = 3;

export function createPendingQueue({ max = PENDING_MAX } = {}) {
  const byScope = new Map(); // scope -> [{ id, at, from }]

  function normalize(scope) {
    return String(scope ?? '').toLowerCase() === 'group' ? 'group' : 'private';
  }

  return {
    add(scope, item = {}) {
      const sc = normalize(scope);
      const id = String(item.id ?? '').trim();
      if (!id) return false;
      const list = byScope.get(sc) || [];
      if (list.some((x) => x.id === id)) return false;   // 同一条不重复挂
      list.push({ id, at: Number(item.at) || Date.now(), from: String(item.from ?? '').slice(0, 20) });
      while (list.length > max) list.shift();
      byScope.set(sc, list);
      return true;
    },
    /** 取走（默认清空）：返回该 scope 当前的待判列表。 */
    take(scope, { clear = true } = {}) {
      const sc = normalize(scope);
      const list = (byScope.get(sc) || []).slice();
      if (clear) byScope.delete(sc);
      return list;
    },
    peek(scope) {
      return (byScope.get(normalize(scope)) || []).slice();
    },
    size(scope) {
      return (byScope.get(normalize(scope)) || []).length;
    },
    clear() { byScope.clear(); }
  };
}

/** 渲染成给模型看的一小段（空则不出现）。 */
export function renderPendingHint(items, { max = PENDING_MAX } = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, max);
  if (!list.length) return '';
  const ids = list.map((x) => x.id).join('、');
  return `【新收到的表情】${ids}（想看就用 qq_get_sticker_image，觉得有用再 qq_collect_sticker 并说明它表达什么；没意思就忽略）`;
}
