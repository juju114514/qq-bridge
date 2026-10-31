// 空间说说的「删除 / 挑图」纯逻辑（0.4.80）
//
// 为什么单独一个模块：
//   · 删除要试多个 action 名（不同 OneBot 实现的命名不统一），这份候选表值得被测试固定住
//   · 挑图要在**没有视觉能力**时也能给出可用建议：按描述/文件名与草稿文字的相关度算分，
//     而不是假装 AI 看懂了

/** 删除 action 候选：按可能性排序，认第一个成功的 */
export const QZONE_DELETE_ACTIONS = Object.freeze([
  'delete_qzone_msg',
  'del_qzone_msg',
  'delete_qzone',
  'qzone_delete'
]);

/** 中文/英文都做最小分词：按非字母数字切，保留 2 字以上的片段 */
export function tokensOf(text) {
  const s = String(text || '').toLowerCase();
  const raw = s.split(/[^0-9a-z\u4e00-\u9fa5]+/).filter(Boolean);
  const out = new Set();
  for (const w of raw) {
    if (w.length >= 2 && /[0-9a-z]/.test(w)) out.add(w);
  }
  // 中文按 2 字滑窗（够用，且不需要词典）
  const cjk = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i + 2 <= seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return out;
}

/**
 * 给候选图打分：描述/文件名 与 草稿文字的词汇重叠。
 * @returns {Array<{id,name,desc,score,reason}>} 按分数降序
 */
export function scoreImages({ text = '', items = [] } = {}) {
  const want = tokensOf(text);
  return (Array.isArray(items) ? items : [])
    .map((it) => {
      const hay = `${it.desc || ''} ${it.name || ''}`;
      const have = tokensOf(hay);
      let hits = 0;
      for (const t of have) if (want.has(t)) hits += 1;
      const descBonus = it.desc ? 0.5 : 0;   // 有描述的更可信
      const score = hits + descBonus;
      return {
        id: it.id,
        name: it.name || it.id,
        desc: it.desc || '',
        score,
        reason: hits ? `与正文有 ${hits} 处词重合` : (it.desc ? '描述可用但与正文无重合' : '无描述（只能按文件名）')
      };
    })
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

/**
 * 挑 1~2 张：分数最高的先选；同分时优先有描述的；再不行按上传时间新→旧。
 * 返回的 id 数组长度永远 ≤ max（默认 2）——这是"别让空间变成相册"的产品约束。
 */
export function pickImages({ text = '', items = [], max = 2 } = {}) {
  const scored = scoreImages({ text, items });
  if (!scored.length) return [];
  const limit = Math.max(1, Math.min(2, Number(max) || 2));
  const positive = scored.filter((x) => x.score > 0);
  const chosen = (positive.length ? positive : scored).slice(0, limit);
  return chosen.map((x) => x.id);
}
