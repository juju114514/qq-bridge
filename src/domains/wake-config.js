// 唤醒配置（"什么时候再叫醒我"）的默认值与刷新规则。
//
// 波次 1 的纯数据域之一：这里没有任何网络/定时器副作用，
// 输入只有 cfg.socialV2.wake 和当前时间，输出是一份完整的 wakeConfig。
//
// 三条规则值得单独说明：
//   1. **只刷新"仍是默认值"的会话**（confirmedBy === 'default'）。
//      AI 用 set_wake_config 或 mark_read 显式设过的，绝不能被默认值覆盖。
//   2. 有限潜水的时长在 [recommendedSleepMinMs, recommendedSleepMaxMs] 内随机，
//      再被 [sleepMinMs, sleepMaxMs] 硬夹一次 —— 硬边界优先于推荐区间。
//   3. 触发器白名单固定，防止有人用垃圾键把状态文件撑大。

export const WAKE_TRIGGER_KEYS = Object.freeze([
  'atMention', 'nameMention', 'speakerIds', 'keywords',
  'question', 'poke', 'anyMessage', 'probability'
]);

export function createWakeConfigDomain({ getCfg = () => ({}), now = Date.now } = {}) {
  const wakeCfgOf = () => getCfg()?.socialV2?.wake ?? {};

  function defaultWakeConfig() {
    const w = wakeCfgOf();
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;

    // 有限潜水时长：推荐区间内随机，再被硬边界夹住
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;

    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  /** 只按白名单取触发器字段，其余的丢弃（防状态文件被垃圾键撑大）。 */
  function pickTriggers(source, fallback = {}) {
    const out = {};
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    for (const name of WAKE_TRIGGER_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  /**
   * 把"仍使用默认唤醒配置"的会话刷新为当前推荐值。
   * 关键：AI/管理员显式设过的（confirmedBy !== 'default'）**不覆盖**。
   * @returns {boolean} 是否发生了修改
   */
  function refreshDefault(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfig();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  return { WAKE_TRIGGER_KEYS, defaultWakeConfig, pickTriggers, refreshDefault };
}