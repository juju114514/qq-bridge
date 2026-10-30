// 进线管道里的"媒体阶段"—— 波次 3 的第一块。
//
// 只做两件与媒体有关的记账，**都不影响消息本身能不能进模型**：
//   1. 待判表情：把这条消息里的图/表情挂进队列，交给 AI 自己决定要不要看/要不要收
//   2. 媒体引用：按 message_id / seq 存图，让后续"引用某条消息"时还能拿到图
//
// 两条硬约束（都对应真实事故）：
//   · 表情记录失败**绝不影响收消息**：所以整体包在 try/catch 里，失败静默
//   · 媒体引用必须**有界**：Map 保持插入序，超上限删最旧；否则长跑必涨内存

/**
 * 记录"待判表情"。
 * @returns {number} 入队条数（失败返回 0，绝不抛）
 */
export function capturePendingStickers({
  enabled,
  key,
  event,
  stickerScopeOf,
  stickerPending,
  maxPerMessage = 3
}) {
  try {
    if (!enabled || !Array.isArray(event?.message)) return 0;
    const scope = stickerScopeOf(key);
    const mid = String(event?.message_id ?? event?.messageId ?? 'm');
    const from = String(event?.sender?.card ?? event?.sender?.nickname ?? event?.sender?.user_id ?? '').slice(0, 40);
    let added = 0;
    for (const seg of event.message.filter((s) => ['image', 'face', 'mface'].includes(String(s?.type ?? ''))).slice(0, maxPerMessage)) {
      // 只记 id + 来源，不存图（图按需再取）
      stickerPending.add(scope, { id: `${mid}:${added}`, from });
      added += 1;
    }
    return added;
  } catch {
    return 0;   // 表情记录失败绝不影响收消息
  }
}

/**
 * 把这条消息的媒体按 message_id / seq 存起来，供"引用这条消息"时取图。
 * @returns {number} 本次写入的引用数
 */
export function rememberMessageMedia({
  key,
  event,
  mediaList,
  messageMediaStore,
  maxPerKey = 200
}) {
  if (!Array.isArray(mediaList) || mediaList.length === 0) return 0;
  const messageRef = String(event?.message_id ?? event?.msg_id ?? event?.message_seq ?? '');
  const seqRef = event?.message_seq != null ? String(event.message_seq) : '';
  const refs = [...new Set([messageRef, seqRef].filter(Boolean))];
  if (refs.length === 0) return 0;

  let byRef = messageMediaStore.get(key);
  if (!byRef) {
    byRef = new Map();
    messageMediaStore.set(key, byRef);
  }
  for (const ref of refs) byRef.set(ref, mediaList);

  // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
  while (byRef.size > maxPerKey) {
    const oldest = byRef.keys().next().value;
    if (oldest === undefined) break;
    byRef.delete(oldest);
  }
  return refs.length;
}