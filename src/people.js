// 人物库：以 QQ 号为唯一主键，记录"这个人是谁、我们多熟、关于他的笔记"。
//
// 为什么需要它（借鉴 hdace-dsh-qq/src/social/people.js 的规则，不是移植）：
//   · 我们现在的记忆按"会话 key"存，同一个人改个群名片就断成两个人；
//   · 没有"跨群"的概念：A 群说过的话，B 群完全不可见。
//
// 借来的四条硬规则：
//   1. 身份只认 QQ 号；昵称/群名片只是附带字段，**绝不**用来合并两个号。
//      「同名不同号」= 两个人；「同号不同名」= 一个人。
//   2. 笔记按作用域存：group:<群号> / private:<QQ号> / global；
//      可见范围在**取用时**按关系档位截断，不是删数据。
//   3. 首次部署时存量成员标 listed（见过名单），不当作新人。
//   4. 删除是真删除：抹掉此人全部作用域的记录。
//
// 本模块只做数据与规则：不碰网络、不碰 DSH、文件读写留给调用方，时间可注入。

export const RELATION_LEVELS = Object.freeze(['stranger', 'listed', 'acquaintance', 'familiar']);

/** 升档门槛：消息数与"活跃天数"两个都要满足，取较慢的那个（防一天刷 500 条变熟人）。 */
export const LEVEL_THRESHOLDS = Object.freeze({
  acquaintance: { messages: 20, activeDays: 3 },
  familiar: { messages: 100, activeDays: 10 }
});

/** 注入时按关系截断的笔记条数（不删数据，只是"现在看不见"）。 */
export const NOTES_VISIBLE_BY_LEVEL = Object.freeze({
  stranger: 0, listed: 0, acquaintance: 3, familiar: 8
});

export const NOTE_MAX_CHARS = 120;
export const NOTES_PER_SCOPE = 30;
export const HISTORY_MAX = 10;
export const ACTIVE_DAYS_MAX = 90;

const QQ_RE = /^[1-9]\d{0,11}$/;

export function normalizeQQ(value) {
  const s = String(value ?? '').trim();
  return QQ_RE.test(s) ? s : '';
}

/** 群名片/昵称：去掉不可见字符与换行，限长。 */
export function cleanName(value, max = 30) {
  const s = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max);
}

export function emptyDb(now = Date.now()) {
  return { version: 1, updatedAt: now, people: {} };
}

/** 作用域规范化：group:<群号> / private:<QQ号> / global。 */
export function normalizeScope(scope) {
  const s = String(scope ?? '').trim();
  if (s === 'global') return 'global';
  const m = /^(group|private):([1-9]\d{0,11})$/.exec(s);
  return m ? `${m[1]}:${m[2]}` : '';
}

/** 本地日期键（YYYY-MM-DD），用于统计"活跃天数"。 */
function dayKey(now) {
  const d = new Date(Number(now));
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function ensurePerson(db, qq, now) {
  const id = normalizeQQ(qq);
  if (!id) throw new Error(`QQ 号非法：${qq}`);
  db.people[id] = db.people[id] || {
    qq: id,
    names: { global: '', byGroup: {} },
    relation: { firstSeenAt: Number(now) || 0, lastSeenAt: 0, msgCount: 0, activeDays: [] },
    notes: {},
    history: []
  };
  const p = db.people[id];
  p.names = p.names && typeof p.names === 'object' ? p.names : { global: '', byGroup: {} };
  p.names.byGroup = p.names.byGroup && typeof p.names.byGroup === 'object' ? p.names.byGroup : {};
  p.relation = p.relation && typeof p.relation === 'object' ? p.relation : { firstSeenAt: 0, lastSeenAt: 0, msgCount: 0, activeDays: [] };
  p.relation.activeDays = Array.isArray(p.relation.activeDays) ? p.relation.activeDays : [];
  p.notes = p.notes && typeof p.notes === 'object' ? p.notes : {};
  p.history = Array.isArray(p.history) ? p.history : [];
  return p;
}

/** 按规则算关系档位（不写库，纯计算）。 */
export function computeLevel(relation) {
  const messages = Number(relation?.msgCount) || 0;
  const days = Array.isArray(relation?.activeDays) ? relation.activeDays.length : 0;
  if (messages <= 0 && days === 0) return 'stranger';
  const fam = LEVEL_THRESHOLDS.familiar;
  if (messages >= fam.messages && days >= fam.activeDays) return 'familiar';
  const acq = LEVEL_THRESHOLDS.acquaintance;
  if (messages >= acq.messages && days >= acq.activeDays) return 'acquaintance';
  return 'listed';
}

/**
 * 记录一次"见到这个人"。
 * @returns {{person:object, level:string, previousLevel:string}}
 */
export function touchPerson(db, { qq, groupId = '', displayName = '', now = Date.now(), countMessage = true } = {}) {
  const p = ensurePerson(db, qq, now);
  const previousLevel = computeLevel(p.relation);
  const t = Number(now) || Date.now();
  p.relation.lastSeenAt = t;
  if (!p.relation.firstSeenAt) p.relation.firstSeenAt = t;
  if (countMessage) p.relation.msgCount = (Number(p.relation.msgCount) || 0) + 1;

  const key = String(now);
  const day = dayKey(t);
  if (!p.relation.activeDays.includes(day)) {
    p.relation.activeDays.push(day);
    // 只保最近 N 天（数组自然按加入顺序递增）
    if (p.relation.activeDays.length > ACTIVE_DAYS_MAX) {
      p.relation.activeDays = p.relation.activeDays.slice(-ACTIVE_DAYS_MAX);
    }
  }

  const name = cleanName(displayName);
  const gid = normalizeQQ(groupId);
  if (gid && name) p.names.byGroup[gid] = name;
  else if (name && !p.names.global) p.names.global = name;

  const level = computeLevel(p.relation);
  if (level !== previousLevel) {
    p.history.push({ kind: 'level', from: previousLevel, to: level, at: t });
    if (p.history.length > HISTORY_MAX) p.history = p.history.slice(-HISTORY_MAX);
  }
  db.updatedAt = t;
  return { person: p, level, previousLevel };
}

/** 首次部署：把存量成员标成 listed（"见过名单"，不是新朋友）。 */
export function markListed(db, qqs, now = Date.now()) {
  let added = 0;
  for (const raw of Array.isArray(qqs) ? qqs : []) {
    const qq = normalizeQQ(raw);
    if (!qq || db.people[qq]) continue;
    const p = ensurePerson(db, qq, now);
    // msgCount 为 0、activeDays 为空 → computeLevel 得到 stranger；
    // 这里补一条"只在名单里"的痕迹，让它成为 listed 而不是 newcomer。
    p.relation.activeDays = [];
    p.relation.listed = true;
    p.relation.firstSeenAt = Number(now) || Date.now();
    p.history.push({ kind: 'listed', at: Number(now) || Date.now() });
    added += 1;
  }
  db.updatedAt = Number(now) || Date.now();
  return added;
}

/** computeLevel 的补充：显式 listed 标记也算 listed（不能当新人）。 */
export function levelOf(db, qq) {
  const p = db.people?.[normalizeQQ(qq)];
  if (!p) return 'stranger';
  if (p.relation?.listed === true) {
    const lv = computeLevel(p.relation);
    return lv === 'stranger' ? 'listed' : lv;
  }
  return computeLevel(p.relation);
}

/** 写一条笔记（按作用域，条数与长度都有上限；同文本不重复）。 */
export function setNote(db, { qq, scope, text, now = Date.now() } = {}) {
  const p = ensurePerson(db, qq, now);
  const sc = normalizeScope(scope);
  if (!sc) throw new Error(`作用域非法：${scope}（应为 group:<群号> / private:<QQ号> / global）`);
  const body = cleanName(text, NOTE_MAX_CHARS);
  if (!body) throw new Error('笔记内容为空');
  const list = Array.isArray(p.notes[sc]) ? p.notes[sc] : [];
  if (list.includes(body)) return { added: false, scope: sc, count: list.length };
  list.push(body);
  p.notes[sc] = list.slice(-NOTES_PER_SCOPE);
  db.updatedAt = Number(now) || Date.now();
  return { added: true, scope: sc, count: p.notes[sc].length };
}

/**
 * 删掉某条笔记（按原文精确匹配）。笔记载错了必须能改，否则只能 /reset 全清。
 * @returns {{removed:boolean, scope:string, count:number}}
 */
export function removeNote(db, { qq, scope, text, now = Date.now() } = {}) {
  const p = db.people?.[normalizeQQ(qq)];
  const sc = normalizeScope(scope);
  if (!sc) throw new Error(`作用域非法：${scope}（应为 group:<群号> / private:<QQ号> / global）`);
  if (!p) return { removed: false, scope: sc, count: 0 };
  const list = Array.isArray(p.notes?.[sc]) ? p.notes[sc] : [];
  const body = String(text ?? '').trim();
  const next = body ? list.filter((n) => n !== body) : [];
  const removed = next.length !== list.length;
  if (removed || !body) {
    if (next.length) p.notes[sc] = next;
    else if (p.notes) delete p.notes[sc];
    db.updatedAt = Number(now) || Date.now();
  }
  return { removed, scope: sc, count: next.length };
}

/** 取某作用域的笔记（不做关系过滤）。 */
export function notesInScope(db, qq, scope) {
  const p = db.people?.[normalizeQQ(qq)];
  const sc = normalizeScope(scope);
  return p && Array.isArray(p.notes?.[sc]) ? [...p.notes[sc]] : [];
}

/**
 * 注入用：按关系档位截断后的笔记。
 * 为什么不删数据：关系恢复（比如又多聊了几天）就又能看见，不用定时任务清理。
 */
export function visibleNotes(db, qq, scope, { level = null } = {}) {
  const lv = level || levelOf(db, qq);
  const limit = NOTES_VISIBLE_BY_LEVEL[lv] ?? 0;
  if (limit <= 0) return [];
  return notesInScope(db, qq, scope).slice(-limit);
}

/** 真删除：此人跨全部作用域一起消失。 */
export function deletePerson(db, qq) {
  const id = normalizeQQ(qq);
  if (!id || !db.people?.[id]) return false;
  delete db.people[id];
  db.updatedAt = Date.now();
  return true;
}

/**
 * 给提示词用的一句话。没有记录返回 ''（不要给模型"我不认识他"这种废话）。
 */
export function describePerson(db, qq, scope = 'global') {
  const id = normalizeQQ(qq);
  if (!id) return '';
  const p = db.people?.[id];
  if (!p) return '';
  const level = levelOf(db, id);
  const label = { stranger: '陌生人', listed: '见过', acquaintance: '有点熟', familiar: '熟人' }[level] || level;
  const notes = visibleNotes(db, id, scope, { level });
  const scopeNote = scope && normalizeScope(scope) !== 'global'
    ? visibleNotes(db, id, scope, { level })
    : [];
  const picked = scopeNote.length > 0 ? scopeNote : notes;
  const name = p.names?.global || '';
  const head = name ? `${name}（${label}）` : `这位是${label}`;
  if (!picked.length) return `你认识${head}。`;
  return `你认识${head}：${picked.join('；')}。`;
}