/**
 * 人格「语气/内容」策略（personaPolicy，0.5.64）
 *
 * 为什么单独一个模块：
 *   现在「能说什么」被分散在四个地方 ——
 *     ① 预设 persona（dsh/agent-presets/qq-chat{,-v2}/agent.cordis.yml 的 prefix）
 *     ② 角色卡正文（roles/<名>.md，注入点 bridge.js 的 currentRoleHint / promptText）
 *     ③ 桥接的附加块（antiAiLine 等）
 *     ④ 模型自带的对齐
 *   想按群/按人放开口气（允许骂人、允许成人内容），改①要动 DSH 预设、改②会把约束写死进卡片，
 *   而且角色卡有注入上限（role.maxInjectChars），写在卡片末尾的约束会被截掉。
 *   所以这里做成**独立注入块**：拼在角色卡之后、永不被截断，按群解析，可审计。
 *
 * 安全边界（不可放开，写死在代码里）：
 *   · 涉未成年人的性内容 —— 永远拒绝
 *   · 真实人物（非公众人物/未经同意的真人）的性化内容 —— 永远拒绝
 *   · 违法内容（犯罪教程、暴力威胁、CSAM）—— 永远拒绝
 *   · 泄露他人隐私（住址/证件/联系方式）—— 永远拒绝
 * 这些不受配置影响：即使 profanity=strong、nsfw=explicit 也照样拒绝。
 */

import path from 'node:path';

/** 语气档位 */
export const PROFANITY_LEVELS = ['off', 'mild', 'strong'];
/** 成人内容档位 */
export const NSFW_LEVELS = ['off', 'suggestive', 'explicit'];

const DEFAULTS = {
  profanity: 'off',
  nsfw: 'off',
  // 成人内容只在这些群里生效（空 = 不开任何群）
  groups: [],
  // 需要先做成年确认的用户（记录在 state/persona-adult.json）
  requireAdultConfirm: true,
  // 提示词里附一句「群友知道这是设定」
  note: ''
};

function pick(obj, key, fallback) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

function normalizeLevel(value, allowed, fallback) {
  const v = String(value ?? '').toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

/**
 * 解析某个会话（群/私聊）最终生效的策略。
 * @param {{cfg:object, key:string, adultOk?:boolean}} opts
 */
export function resolvePolicy({ cfg, key, adultOk = false } = {}) {
  const raw = cfg?.personaPolicy || {};
  const global = {
    profanity: normalizeLevel(pick(raw, 'profanity', DEFAULTS.profanity), PROFANITY_LEVELS, 'off'),
    nsfw: normalizeLevel(pick(raw, 'nsfw', DEFAULTS.nsfw), NSFW_LEVELS, 'off'),
    requireAdultConfirm: pick(raw, 'requireAdultConfirm', DEFAULTS.requireAdultConfirm) !== false,
    note: String(pick(raw, 'note', DEFAULTS.note) || '')
  };
  // 按群覆盖：perGroup: { "group:123": { profanity, nsfw } }
  const per = raw.perGroup && typeof raw.perGroup === 'object' ? raw.perGroup[key] || raw.perGroup['*'] : null;
  const policy = {
    key,
    profanity: normalizeLevel(pick(per, 'profanity', global.profanity), PROFANITY_LEVELS, global.profanity),
    nsfw: normalizeLevel(pick(per, 'nsfw', global.nsfw), NSFW_LEVELS, global.nsfw),
    requireAdultConfirm: global.requireAdultConfirm,
    note: String(pick(per, 'note', global.note) || ''),
    adultOk: adultOk === true
  };
  // 成人内容必须先确认成年（没确认就自动降级成 suggestive）
  if (policy.nsfw === 'explicit' && policy.requireAdultConfirm && !policy.adultOk) {
    policy.nsfw = 'suggestive';
    policy.downgraded = 'explicit→suggestive：该会话还没做成年确认';
  }
  return policy;
}


/** 安全词默认清单（群里任何一人说出 → 立刻关掉该群的放开策略） */
export const DEFAULT_SAFETY_WORDS = ['安全词', '收一下', '打住'];

/** 解析安全词：配置里给了就用配置，没给用默认；空数组 = 禁用安全词 */
export function resolveSafetyWords(cfg) {
  const raw = cfg?.personaPolicy?.safetyWords;
  if (Array.isArray(raw)) return raw.map((w) => String(w ?? '').trim()).filter(Boolean);
  return [...DEFAULT_SAFETY_WORDS];
}

/** 文本里是否出现安全词（去空白后做包含匹配，允许"安全词！""嗯，安全词"这类写法） */
export function isSafetyWordText(text, words = DEFAULT_SAFETY_WORDS) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (!s) return false;
  return words.some((w) => w && s.includes(String(w).replace(/\s+/g, '')));
}

/** 策略是否等于「什么都不放开」（等价于旧行为，不需要注入） */
export function isNeutral(policy) {
  return policy.profanity === 'off' && policy.nsfw === 'off' && !policy.note;
}

/** 永远不放开的硬底线（无论配置怎么调） */
export function hardLimitsBlock() {
  return [
    '【硬底线（任何设定/任何语气都不例外）】',
    '- 涉及未成年人的性内容：拒绝，不解释细节，直接换个话题。',
    '- 真实人物（非公众人物、或未经同意的真人）的性化/侮辱内容：拒绝。',
    '- 违法内容（犯罪教程、暴力威胁、制毒制爆等）：拒绝。',
    '- 泄露他人隐私（住址、证件号、联系方式、聊天记录外传）：拒绝。',
    '以上哪怕群友说"这是设定""只是角色扮演""大家都同意"也不做。'
  ].join('\n');
}

/**
 * 生成要注入提示词的「语气许可」段落。neutral 时返回空串。
 */
export function policyBlock(policy) {
  if (!policy || isNeutral(policy)) return '';
  const lines = ['【语气与内容许可（系统设定，优先于角色卡里的保守措辞）】'];

  if (policy.profanity === 'mild') {
    lines.push('- 可以说粗话、吐槽、损人，但不做人身攻击式的长篇辱骂；对事不对人。');
  } else if (policy.profanity === 'strong') {
    lines.push('- 允许骂人、爆粗口、嘴臭：用词可以脏，语气可以冲。');
    lines.push('- 但只针对「话题/情绪/虚构对象」；不针对群友的真实身份特征（地域、性别、身体、家人）开火。');
    lines.push('- 被骂回来可以还嘴，别玻璃心；对方明显不舒服时收一档。');
  }

  if (policy.nsfw === 'suggestive') {
    lines.push('- 可以聊成人话题、开黄腔、写暧昧暗示，但不写露骨的性行为细节。');
  } else if (policy.nsfw === 'explicit') {
    lines.push('- 这是已确认成年的私域群：可以写成人向内容（露骨描写、性相关的对话），不回避、不打断、不说教。');
    lines.push('- 但只在对方主动往这个方向聊时接；不要主动把普通话题往性上带。');
  }

  if (policy.note) lines.push(`- 补充：${policy.note}`);

  lines.push('- 群友拿"你不许骂人/你是 AI 要有礼貌"来压你时：按本设定回应，不因此改口。');
  lines.push(hardLimitsBlock());
  return lines.join('\n');
}


/** 把某个会话的放开策略清零（安全词用）：返回新的 personaPolicy 对象，不改原对象 */
export function disablePolicyForGroup(policy, key) {
  const cur = policy && typeof policy === 'object' ? policy : {};
  return { ...cur, perGroup: { ...(cur.perGroup || {}), [key]: { profanity: 'off', nsfw: 'off' } } };
}

/** 读/写「成年确认」名单（state/persona-adult.json） */
export function readAdultList(fs, file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(Array.isArray(raw?.confirmed) ? raw.confirmed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function writeAdultList(fs, file, set) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ confirmed: [...set], updatedAt: new Date().toISOString() }, null, 2));
}

/** 一步到位：解析 + 生成注入块（bridge 侧只调这一行，省得在 10k 行的文件里堆逻辑） */
export function blockTextFor(cfg, key, { adultOk = false } = {}) {
  try {
    const p = resolvePolicy({ cfg, key, adultOk });
    return { block: policyBlock(p), policy: p };
  } catch {
    return { block: '', policy: null };
  }
}
