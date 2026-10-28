// 表情包策展：让 AI 自己判断"这个表情是什么意思、对聊天有没有用"，
// 有用就收藏，没用就丢掉；并且在聊天里**主动**用表情，而不是等被 @。
//
// 设计原则：
//   1) 纯函数 + 依赖注入 —— 全部可离线测试，不碰网络/磁盘
//   2) 决策与执行分离 —— 这里只回答"要不要"，真正收藏/发送由调用方做
//   3) 有配额和冷却 —— 否则群里刷图会把号刷废
//   4) 余额不敏感的场景（用户自建）可以把阈值调低；默认偏保守

export const DEFAULT_CURATOR = {
  enabled: false,
  autoCollect: true,
  proactiveSend: true,
  minMeaningScore: 0.55,   // 低于这个分：看不懂 / 无意义，直接丢
  minSendRelevance: 0.6,   // 主动发表情的最低相关度
  maxCollectPerDay: 20,
  maxSendPerHour: 6,
  sendCooldownMs: 8 * 60 * 1000
};

/** 把模型给的一句话收敛成短标签（用于去重与检索）。 */
export function normalizeMeaning(raw) {
  const s = String(raw ?? '').trim()
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!s) return '';
  return s.length > 24 ? s.slice(0, 24) : s;
}

/**
 * 给一个表情打分：它作为"聊天素材"有多好用。
 * @param {{meaning?:string, tags?:string[], duplicate?:boolean, animated?:boolean, eyesOnly?:boolean}} s
 */
export function scoreSticker({ meaning = '', tags = [], duplicate = false, animated = false, eyesOnly = false } = {}) {
  const label = normalizeMeaning(meaning);
  if (!label) return 0;               // 看不懂就没价值
  if (duplicate) return 0;            // 已有同款
  let score = 0.5;
  if (label.length >= 2) score += 0.1;
  if (/(笑|赞|无语|震惊|委屈|嘲讽|摸鱼|晚安|加油|拒绝|害羞|生气)/.test(label)) score += 0.2;
  if (Array.isArray(tags) && tags.length >= 2) score += 0.1;
  if (animated) score += 0.05;
  if (eyesOnly) score -= 0.15;        // 纯文字/无画面的图不算好素材
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

/** 要不要收藏。 */
export function decideCollect({ score = 0, collectedToday = 0 } = {}, opts = {}) {
  const c = { ...DEFAULT_CURATOR, ...(opts || {}) };
  if (!c.enabled || !c.autoCollect) return { collect: false, reason: 'disabled' };
  if (score < c.minMeaningScore) return { collect: false, reason: 'low-value' };
  if (collectedToday >= c.maxCollectPerDay) return { collect: false, reason: 'daily-quota' };
  return { collect: true, reason: 'useful' };
}

/**
 * 要不要主动发表情。
 * @param {{relevance?:number}} candidate 相关度（候选表情与当前话题的贴合度）
 * @param {number} lastSentAt 上次发表情的毫秒时间戳（0=从未）
 */
export function decideProactiveSend(
  { relevance = 0, lastSentAt = 0, sentThisHour = 0, now = Date.now(), mood = '' } = {},
  opts = {}
) {
  const c = { ...DEFAULT_CURATOR, ...(opts || {}) };
  if (!c.enabled || !c.proactiveSend) return { send: false, reason: 'disabled' };
  if (relevance < c.minSendRelevance) return { send: false, reason: 'not-relevant' };
  if (sentThisHour >= c.maxSendPerHour) return { send: false, reason: 'hourly-quota' };
  if (lastSentAt && now - lastSentAt < c.sendCooldownMs) return { send: false, reason: 'cooldown' };
  // 情绪越强，越值得配一张图
  const boost = /(开心|兴奋|生气|委屈|震惊|无语)/.test(String(mood)) ? 0.05 : 0;
  return { send: relevance + boost >= c.minSendRelevance, reason: 'ok' };
}

/** 给模型的指令片段：告诉它什么时候该收藏、什么时候该主动发表情。 */
export function buildCuratorPrompt(opts = {}) {
  const c = { ...DEFAULT_CURATOR, ...(opts || {}) };
  if (!c.enabled) return '';
  const lines = [
    '【表情策展】群友发表情包/图片时：',
    '1. 先用一句话说出它表达什么（如"无语到翻白眼"）；说不出或毫无信息量，就不收藏。',
    '2. 觉得对你以后的聊天有用（能接梗、能怼人、能撒娇）才收藏；同一款不要重复收藏。',
    '3. 闲聊时如果一张现成表情比打字更自然，就直接发，不必等被 @；但一轮对话最多一张。'
  ];
  if (!c.autoCollect) lines.splice(1, 2);
  if (!c.proactiveSend) lines.splice(lines.length - 1, 1);
  return lines.join('\n');
}
