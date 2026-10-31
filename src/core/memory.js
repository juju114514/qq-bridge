// 核心库 · 人物记忆（纯函数，零 IO）
//
// 只放"给定数据库对象，算出等级/可见笔记/描述"这类纯运算；
// 落盘由 sidecar 负责（state/people.json 是单写者模型）。
export {
  RELATION_LEVELS,
  LEVEL_THRESHOLDS,
  NOTES_VISIBLE_BY_LEVEL,
  NOTE_MAX_CHARS,
  normalizeQQ,
  cleanName,
  computeLevel,
  levelOf,
  notesInScope,
  visibleNotes,
  describePerson,
} from '../people.js';