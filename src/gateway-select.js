// 网关自动选择：**默认 SnowLuma**（主程序），连续失败才降级到 NapCat。
//
// 为什么需要回滞（hysteresis）：
//   只看"本次探测失败"就切换，会让桥接在两个网关之间反复横跳 ——
//   每次切换都要重连、丢消息、甚至触发 QQ 互踢。所以：
//     · 连续 failThreshold 次失败才降级
//     · 降级后要连续 recoverThreshold 次成功才回切
//     · 刚切换的冷却期内不再切换（switchCooldownMs）
//
// 探测只做 HTTP get_login_info：它同时证明"端口通 + 令牌对 + 账号已登录"。

export const DEFAULT_GATEWAY_POLICY = {
  preferred: 'snowluma',      // 默认主程序
  fallback: 'napcat',
  enableFallback: true,
  failThreshold: 3,           // 连续失败几次才降级
  recoverThreshold: 5,        // 降级后连续成功几次才回切
  switchCooldownMs: 60_000,   // 切换后冷却
  probeTimeoutMs: 1500
};

/** 探测一个 OneBot 端点是否真的可用（含鉴权与登录态）。 */
export async function probeOneBot({ httpUrl, token = '', timeoutMs = 1500, fetchImpl = globalThis.fetch } = {}) {
  if (!httpUrl) return { ok: false, error: 'no-url' };
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${httpUrl.replace(/\/$/, '')}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ action: 'get_login_info', params: {} }),
      signal: ctrl?.signal
    });
    const data = await res.json().catch(() => ({}));
    const wording = String(data?.wording || data?.message || '');
    if (data?.status === 'ok' || data?.retcode === 0) {
      return { ok: true, nickname: data?.data?.nickname ?? '', userId: data?.data?.user_id ?? null };
    }
    return { ok: false, error: wording || `status=${data?.status ?? res.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.name === 'AbortError' ? 'timeout' : (e?.message ?? e)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 决定当前该用哪个网关（纯函数，便于测试）。
 * @param {{preferred?:string, fallback?:string, enableFallback?:boolean,
 *          failThreshold?:number, recoverThreshold?:number, switchCooldownMs?:number}} policy
 * @param {{current?:string, failStreak?:number, recoverStreak?:number,
 *          lastSwitchAt?:number, now?:number}} state
 */
export function decideGateway(policy = {}, state = {}) {
  const p = { ...DEFAULT_GATEWAY_POLICY, ...(policy || {}) };
  const current = state.current || p.preferred;
  const now = Number(state.now ?? Date.now());
  const failStreak = Number(state.failStreak) || 0;
  const recoverStreak = Number(state.recoverStreak) || 0;
  const lastSwitchAt = Number(state.lastSwitchAt) || 0;

  const cooled = !lastSwitchAt || now - lastSwitchAt >= p.switchCooldownMs;
  const other = current === p.preferred ? p.fallback : p.preferred;

  // 已在备选：要连续成功够多才回主
  if (current !== p.preferred) {
    if (recoverStreak >= p.recoverThreshold && cooled) {
      return { gateway: p.preferred, switched: true, reason: 'recover' };
    }
    return { gateway: current, switched: false, reason: 'holding-fallback' };
  }

  // 在主网关：连续失败够多且允许降级才切
  if (p.enableFallback && failStreak >= p.failThreshold && cooled) {
    return { gateway: other, switched: true, reason: 'failover' };
  }
  return { gateway: current, switched: false, reason: 'holding-preferred' };
}

/** 记录一次探测结果，维护失败/恢复计数。 */
export function recordProbe(state = {}, ok) {
  const s = { ...state };
  if (ok) { s.failStreak = 0; s.recoverStreak = (Number(s.recoverStreak) || 0) + 1; }
  else { s.recoverStreak = 0; s.failStreak = (Number(s.failStreak) || 0) + 1; }
  return s;
}
