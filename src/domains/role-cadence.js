// 角色卡「按节奏注入」——把每轮 23KB 的人格卡，改成「首次/换卡全量，其后每 N 轮一次」。
//
// 为什么要有它：实测每轮提示词约 15K tokens，其中 **10.6K 是角色卡**（占 71%）。
// 换取模型或按量计费时，这部分是纯固定开销；上游在同一天也做了同样的事（#118）。
//
// 安全边界：注入频率只影响"这轮有没有重读规则"，**不影响服务端的权限判定**
// （模式/白名单/令牌都在桥接侧校验）。所以它是纯成本项，默认值保持"每轮全量"。
export function createRoleCadence({ every = 1 } = {}) {
  const n = Math.max(1, Number(every) || 1);
  const seen = new Map(); // key -> { roleId, turn }

  /**
   * @param {string} key 会话 key
   * @param {string} roleId 当前人格 id（换卡时必须立刻全量注入）
   * @returns {boolean} true = 这一轮注入完整角色卡
   */
  function shouldInjectFull(key, roleId, everyOverride) {
    // every 允许按调用覆盖：配置是运行时可改的，而本模块在模块级只初始化一次
    // （早期版本把 every 固定成 1，导致配了 roleInjectEvery 却永远全量注入）。
    const n = Math.max(1, Number(everyOverride ?? every) || 1);
    if (n <= 1) return true;                 // 默认行为：每轮全量
    const k = String(key ?? '');
    const rid = String(roleId ?? '');
    const cur = seen.get(k);
    if (!cur || cur.roleId !== rid) {
      seen.set(k, { roleId: rid, turn: 1 });
      return true;                            // 第一次 / 换卡 → 全量
    }
    cur.turn += 1;
    // 第 1 轮全量之后，每隔 n 轮再来一次（turn = 1, n+1, 2n+1 …）
    return (cur.turn - 1) % n === 0;
  }

  /** 清空计数（改配置、切角色后可调用；不调用也只是提前一轮全量，无副作用） */
  function reset(key) {
    if (key === undefined) seen.clear();
    else seen.delete(String(key));
  }

  return { shouldInjectFull, reset, every: n };
}