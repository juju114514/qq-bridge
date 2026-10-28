// 长期记忆的"原子"与生命周期：权重、衰减、命中强化、打分检索、合并、归档。
//
// 为什么要有这层：现有的 `activeTopics / pendingThoughts / memberImpressions` 只有
// "24 小时就删"和"容量截断"两种粗糙机制 —— 结果是**没有长期记忆**（上个月的事一定忘）
// 且一条玩笑和一条约定权重相同。这里补的是 LivingMemory 那套结构里真正有用的部分：
//
//   原子 = { text, tags, weight, createdAt, lastHitAt, hits, source }
//   衰减 = 0.5 ^ (天数 / 30)          ← 半年没提基本等于忘掉
//   强化 = 被检索命中时 weight += 0.3（上限 3），lastHitAt = now
//   打分 = 0.6·关键词覆盖 + 0.3·归一化权重 + 0.1·新鲜度
//   合并 = 词集 Jaccard ≥ 0.6 视为同一条，加权而不是新增
//   归档 = 有效权重 < 0.05 的移出热存，写进归档文件
//
// 纯函数、无 IO：便于离线测试，也便于从 socialV2 的读写端点两处调用。

export const HALF_LIFE_DAYS = 30;
export const WEIGHT_CAP = 3;
export const REINFORCE_STEP = 0.3;
export const MERGE_JACCARD = 0.6;
export const ARCHIVE_WEIGHT = 0.05;
export const MAX_ATOMS = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 中文没有空格：CJK 取二元组，拉丁/数字取整词。用于关键词覆盖与相似度。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const tokens = new Set();
  for (const m of s.matchAll(/[a-z0-9_]+/g)) tokens.add(m[0]);
  const cjk = s.replace(/[^\u4e00-\u9fff]+/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (!run) continue;
    if (run.length === 1) { tokens.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/** 时间衰减后的**有效**权重（存储里保留基准 weight，衰减只在读时算）。 */
export function effectiveWeight(atom, now = Date.now()) {
  const weight = Number(atom?.weight);
  const created = Number(atom?.createdAt);
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  const days = Number.isFinite(created) ? Math.max(0, (now - created) / DAY_MS) : 0;
  return weight * Math.pow(0.5, days / HALF_LIFE_DAYS);
}

/** 命中强化：权重与次数都涨，lastHitAt 刷新（用于"越聊越牢"）。 */
export function reinforce(atom, now = Date.now()) {
  if (!atom || typeof atom !== 'object') return atom;
  atom.weight = Math.min(WEIGHT_CAP, (Number(atom.weight) || 1) + REINFORCE_STEP);
  atom.hits = (Number(atom.hits) || 0) + 1;
  atom.lastHitAt = now;
  return atom;
}

/**
 * 单条打分。query 为空时退化成"纯权重 × 新鲜度"（保证没查询也能按重要度排序）。
 * @returns {{score:number, overlap:number, effective:number, freshness:number}}
 */
export function scoreAtom(atom, query, now = Date.now()) {
  const q = query instanceof Set ? query : tokenize(query);
  const a = tokenize(atom?.text);
  let overlap = 0;
  if (q.size > 0) {
    let hit = 0;
    for (const t of q) if (a.has(t)) hit += 1;
    overlap = hit / q.size;
  }
  const eff = effectiveWeight(atom, now);
  const weightPart = Math.min(1, eff / WEIGHT_CAP);
  const days = Math.max(0, (now - (Number(atom?.lastHitAt) || Number(atom?.createdAt) || now)) / DAY_MS);
  const freshness = Math.pow(0.5, days / 7);
  const score = 0.6 * overlap + 0.3 * weightPart + 0.1 * freshness;
  return { score, overlap, effective: eff, freshness };
}

/**
 * 打分排序 + 预算裁剪：条数上限与总字符上限同时生效（注入 prompt 必须有硬预算）。
 * 返回按分数降序的原子副本（不改原数组）。
 */
export function rankAtoms(atoms, { query = '', now = Date.now(), limit = 6, maxChars = 800, minScore = 0.12 } = {}) {
  const q = tokenize(query);
  const scored = (Array.isArray(atoms) ? atoms : [])
    .filter((a) => a && String(a.text ?? '').trim())
    .map((a) => ({ atom: a, ...scoreAtom(a, q, now) }))
    .filter((x) => x.score >= minScore)
    .sort((x, y) => y.score - x.score);
  const out = [];
  let chars = 0;
  for (const x of scored) {
    const len = String(x.atom.text).length;
    if (out.length >= limit) break;
    if (out.length > 0 && chars + len > maxChars) continue; // 超预算就试着塞更短的，别直接截断语义
    out.push(x);
    chars += len;
  }
  return out;
}

/** 词集 Jaccard 相似度（0~1）。 */
export function similarity(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * 写入即合并：相似度够高就加权（旧条目更强），否则新增。返回 'merged' | 'added'。
 * 同时做容量控制：超出 MAX_ATOMS 时先按有效权重淘汰最弱的。
 */
export function addAtom(atoms, { text, tags = [], source = '', now = Date.now() } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return { action: 'skipped' };
  const list = Array.isArray(atoms) ? atoms : [];
  const hit = list.find((a) => a && similarity(a.text, clean) >= MERGE_JACCARD);
  if (hit) {
    hit.text = clean.length > String(hit.text).length ? clean : hit.text;
    hit.weight = Math.min(WEIGHT_CAP, (Number(hit.weight) || 1) + 0.2);
    hit.hits = (Number(hit.hits) || 0) + 1;
    hit.lastHitAt = now;
    const set = new Set([...(Array.isArray(hit.tags) ? hit.tags : []), ...tags.map(String)]);
    hit.tags = [...set].slice(0, 8);
    return { action: 'merged', atom: hit };
  }
  const atom = {
    text: clean,
    tags: tags.map(String).slice(0, 8),
    weight: 1,
    createdAt: now,
    lastHitAt: now,
    hits: 0,
    source: String(source ?? '')
  };
  list.push(atom);
  // 容量控制：超限就反复淘汰最弱的一条（按有效权重，不看插入顺序）。
  // 用 while 而不是 if：旧数据可能一次就带进来好几百条，不能只删一条了事。
  while (list.length > MAX_ATOMS) {
    let weakest = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (effectiveWeight(list[i], now) < effectiveWeight(list[weakest], now)) weakest = i;
    }
    list.splice(weakest, 1);
  }
  return { action: 'added', atom };
}

/** 归档：把有效权重低于阈值的移出热存（返回两份，调用方决定写哪）。 */
export function archiveAtoms(atoms, { now = Date.now(), minWeight = ARCHIVE_WEIGHT } = {}) {
  const keep = [];
  const archived = [];
  for (const a of Array.isArray(atoms) ? atoms : []) {
    if (!a) continue;
    if (effectiveWeight(a, now) < minWeight) archived.push(a);
    else keep.push(a);
  }
  return { keep, archived };
}

/**
 * 从旧结构迁移：把 activeTopics 与 memberImpressions 变成原子。
 * 旧数据没有权重概念 → weight=1，createdAt 用最后提及时间（没有就用 now）。
 * pendingThoughts 不迁移（它是"两小时内想说没说"的临时物，不属于长期记忆）。
 */
export function migrateFromLegacy(st, now = Date.now()) {
  const atoms = [];
  for (const t of Array.isArray(st?.activeTopics) ? st.activeTopics : []) {
    const text = String(t?.text ?? '').trim();
    if (!text) continue;
    atoms.push({
      text,
      tags: ['话题'],
      weight: 1,
      createdAt: Number(t?.lastMentionAt) || now,
      lastHitAt: Number(t?.lastMentionAt) || now,
      hits: 0,
      source: 'legacy:activeTopic'
    });
  }
  const impressions = st?.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  for (const [name, im] of Object.entries(impressions)) {
    const traits = Array.isArray(im?.traits) ? im.traits.filter(Boolean) : [];
    if (!traits.length) continue;
    atoms.push({
      text: `${name}：${traits.join('、')}`,
      tags: ['群友'],
      weight: 1,
      createdAt: now,
      lastHitAt: now,
      hits: Number(im?.interactionCount) || 0,
      source: 'legacy:memberImpression'
    });
  }
  return atoms;
}

/** 注入用的文本块：只带 top-K，且每条截断，保证 prompt 预算可控。 */
export function formatLongTerm(atoms, { query = '', now = Date.now(), limit = 6, maxChars = 800 } = {}) {
  const ranked = rankAtoms(atoms, { query, now, limit, maxChars });
  if (ranked.length === 0) return '';
  const lines = ['【记得的事】'];
  for (const x of ranked) {
    const text = String(x.atom.text);
    lines.push(`- ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`);
  }
  return lines.join('\n');
}
