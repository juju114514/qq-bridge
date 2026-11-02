// 大脑路由（0.5.53 · P1「在家用 PC、出门用手机」）
//
// 设计前提：**桥接只有一份**（在手机上），换的只是"思考端"。
// 这样 state/ 是唯一真相源，QQ 不用重登，表情/群列表不用重建。
//
// 三条硬规则：
//   1. 一轮对话进行中**绝不切换**（否则同一句回复可能拼两套逻辑）
//   2. 连续 N 次探测失败才判"掉线"，一次抖动不切（家里 Wi-Fi 很爱抖）
//   3. 切换后有冷却期，避免在边界上反复横跳
import { probeDsh } from '../dsh-probe.js';

export const BRAIN_LOCAL = 'local';
export const BRAIN_DSH = 'dsh';

/**
 * @param {{
 *   probe?: Function,            // async () => ({ok:boolean, detail?:string})
 *   failThreshold?: number,      // 连续失败几次才算掉线（默认 3）
 *   recoverThreshold?: number,   // 连续成功几次才算回来（默认 2）
 *   cooldownMs?: number,         // 切换冷却（默认 30s）
 *   now?: Function,
 *   log?: Function,
 *   initial?: string
 * }} opts
 */
export function createBrainRouter(opts = {}) {
  const {
    probe = async () => ({ ok: false, detail: 'no-probe' }),
    failThreshold = 3,
    recoverThreshold = 2,
    cooldownMs = 30000,
    now = () => Date.now(),
    log = () => {},
    initial = BRAIN_LOCAL
  } = opts;

  let current = initial === BRAIN_DSH ? BRAIN_DSH : BRAIN_LOCAL;
  let okStreak = 0;
  let failStreak = 0;
  let lastSwitchAt = 0;
  let lastProbeAt = 0;
  let lastProbeOk = false;
  let lastReason = 'init';
  const history = [];

  function record(to, reason) {
    lastSwitchAt = now();
    lastReason = reason;
    current = to;
    history.push({ at: lastSwitchAt, to, reason });
    if (history.length > 20) history.shift();
    log(`[brain] 切到 ${to}（${reason}）`);
  }

  /**
   * 探一次并更新状态。返回当前应该用哪个大脑。
   * @returns {Promise<{brain:string, switched:boolean, probeOk:boolean, detail?:string}>}
   */
  async function tick() {
    lastProbeAt = now();
    let r;
    try {
      r = await probe();
    } catch (error) {
      r = { ok: false, detail: String(error?.message ?? error).slice(0, 120) };
    }
    lastProbeOk = Boolean(r?.ok);
    if (lastProbeOk) { okStreak += 1; failStreak = 0; } else { failStreak += 1; okStreak = 0; }

    const cooled = now() - lastSwitchAt >= cooldownMs;
    let switched = false;
    if (current === BRAIN_DSH && failStreak >= failThreshold && cooled) {
      record(BRAIN_LOCAL, `中继连续 ${failStreak} 次不可达`);
      switched = true;
    } else if (current === BRAIN_LOCAL && okStreak >= recoverThreshold && cooled) {
      record(BRAIN_DSH, `中继恢复（连续 ${okStreak} 次可达）`);
      switched = true;
    }
    return { brain: current, switched, probeOk: lastProbeOk, detail: r?.detail };
  }

  /** 手动指定（控制台用），并进入冷却 */
  function force(brain, reason = 'manual') {
    const to = brain === BRAIN_DSH ? BRAIN_DSH : BRAIN_LOCAL;
    if (to === current) return current;
    record(to, reason);
    return current;
  }

  function status() {
    return {
      brain: current,
      okStreak,
      failStreak,
      lastProbeOk,
      lastProbeAt,
      lastSwitchAt,
      lastReason,
      history: history.slice(-8)
    };
  }

  return { tick, force, status, get brain() { return current; } };
}

/** 从 config.agent.auto 造一个探测函数：打中继上的 DSH 探活端点 */
export function createRelayProbe(agentCfg = {}) {
  const baseUrl = String(agentCfg?.auto?.dshBaseUrl || agentCfg?.auto?.probeUrl || '').trim();
  if (!baseUrl) return async () => ({ ok: false, detail: '未配置 agent.auto.dshBaseUrl' });
  const timeoutMs = Number(agentCfg?.auto?.timeoutMs) || 800;
  return async () => {
    const r = await probeDsh({ baseUrl });
    // 路由只关心「端口通不通」：鉴权/事件流是桥接自己的事，
    // 拿整条链路的 ok 当判据会导致明明能连也被判成掉线。
    const tcp = (r?.steps || []).find((s) => s.name === 'tcp');
    const ok = Boolean(tcp?.ok);
    return { ok, detail: ok ? '' : String(tcp?.detail || '中继不可达') };
  };
}


// ── 进程内单例：桥接只有一个，探测器也只需要一个 ──
let shared = null;
let timer = null;

/**
 * @param {object} cfg 完整 config（读 cfg.agent.auto）
 * @param {{log?:Function}} [o]
 */
export function getSharedRouter(cfg = {}, o = {}) {
  if (shared) return shared;
  const auto = cfg.agent?.auto || {};
  shared = createBrainRouter({
    probe: createRelayProbe(cfg.agent),
    failThreshold: Number(auto.failThreshold) || 3,
    recoverThreshold: Number(auto.recoverThreshold) || 2,
    cooldownMs: Number(auto.cooldownMs) || 30000,
    initial: BRAIN_LOCAL,
    log: o.log || (() => {})
  });
  const intervalMs = Math.max(5000, Number(auto.intervalMs) || 30000);
  timer = setInterval(() => { shared.tick().catch(() => {}); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  shared.tick().catch(() => {});
  return shared;
}

/** 给接口层看状态用；没初始化过就返回 null（不要为了看状态就开定时器） */
export function sharedRouterStatus() {
  return shared ? shared.status() : null;
}
