// 表情提示词片段：**只影响选图，不改语气**。
//
// 为什么单独一个文件而不是直接拼 JSON：
//   语气是"底色"，写死在人格卡里；表情笔记只该影响"发不发、发哪张"。
//   所以这里做三重限幅，确保它不可能把人格带跑：
//     1) 最多 3 条、总长 ≤ 60 字
//     2) 固定前缀写明"仅供参考，不改语气"
//     3) 空则返回空串（不占 token、不产生任何影响）

export const HINT_MAX_ITEMS = 3;
export const HINT_MAX_CHARS = 60;
export const HINT_PREFIX = '（选图参考，不改语气）';

/**
 * @param {Array<{meaning?:string, uses?:number, status?:string}>} notes
 * @returns {string} 空串表示"不加任何东西"
 */
export function buildBoundedStickerHint(notes) {
  const list = Array.isArray(notes) ? notes : [];
  const usable = list
    .filter((n) => n && n.meaning && n.status === 'kept')
    .sort((a, b) => (b.uses || 0) - (a.uses || 0))
    .slice(0, HINT_MAX_ITEMS)
    .map((n) => String(n.meaning).slice(0, 12));
  if (!usable.length) return '';

  let body = usable.join(' / ');
  if (body.length > HINT_MAX_CHARS) body = body.slice(0, HINT_MAX_CHARS);
  return `${HINT_PREFIX}${body}`;
}
