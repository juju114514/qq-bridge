// 「这条消息该不该叫醒我」—— 波次 2 的第一个域（唤醒判定）。
//
// 这是整套社交行为的**入口闸门**：判错了只有两种后果，而且都不报错：
//   · 该唤醒却没唤醒 → AI 一直不说话，像个死机器人
//   · 不该唤醒却唤醒 → 每个群消息都烧一次 token
//
// 所以每个分支都带着事故注释，别随手"简化"。

/**
 * @param {object} p
 * @param {'group'|'private'|string} p.kind
 * @param {object} p.wakeConfig        会话的 wakeConfig（含 triggers）
 * @param {object} p.event             OneBot 事件（取 at 段、user_id、sender）
 * @param {string} p.plainContent      当前消息自己的文字（**不含**引用原文）
 * @param {string} [p.textContent]     完整文字（可能含 `[引用 某人：…]`）
 * @param {boolean} [p.quoteTargetIsSelf] 是否引用了机器人自己的消息
 * @param {string} [p.selfNickname]    机器人昵称
 * @param {string[]} [p.alwaysKeywords] 常驻关键词（AI 改小触发词也不影响）
 * @param {boolean} [p.lockProbability] 锁定概率（忽略会话里的 probability）
 * @param {(text:string)=>boolean} [p.isDirectedAtAi] 判断"是不是在问我"
 * @param {() => number} [p.random]
 * @returns {string|null} 唤醒原因；null = 不唤醒
 */
export function evaluateWakeTrigger({
  kind,
  wakeConfig,
  event,
  plainContent,
  textContent,
  quoteTargetIsSelf = false,
  selfNickname = '',
  alwaysKeywords = [],
  lockProbability = false,
  isDirectedAtAi = () => false,
  random = Math.random
} = {}) {
  // 私聊一律唤醒（不用配触发器）
  if (kind === 'private') return 'private';

  const tr = wakeConfig?.triggers ?? {};
  if (tr.anyMessage) return 'anyMessage';

  if (tr.atMention) {
    const atSelf = Array.isArray(event?.message)
      && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq ?? '') === String(event?.self_id ?? ''));
    // 官方通道的事件里**没有 at 段**：@ 是网关自己剥掉的（GROUP_AT_MESSAGE_CREATE 这个事件名就代表"被 @"）。
    // 不认这个标记的话，官方群消息会被当成"没人叫我"，静默不回复 —— 真实踩过。
    const officialAt = event?.__official?.atBot === true;
    if (atSelf || officialAt || quoteTargetIsSelf) return 'atMention';
  }

  if (tr.nameMention && selfNickname) {
    // 只用 plainContent：textContent 含 `[引用 某人：原文]`，
    // 引用一条恰好提到机器人昵称的旧消息不该算"叫了名字"（那是被动触发的付费回合）。
    const lower = String(plainContent ?? '').toLowerCase();
    const nick = selfNickname.toLowerCase();
    if (lower.includes('@' + nick) || lower.includes(nick)) return 'nameMention';
  }

  if (Array.isArray(tr.keywords) && tr.keywords.length) {
    const lower = String(plainContent ?? '').toLowerCase();
    for (const kw of tr.keywords) {
      const kwStr = String(kw ?? '').toLowerCase();
      if (!kwStr) continue;
      // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
      if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
        if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
      } else if (lower.includes(kwStr)) {
        return `keyword:${kw}`;
      }
    }
  }

  if (tr.question && isDirectedAtAi(plainContent)) return 'question';

  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
    const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
      const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
      return `speaker:${senderLabel}`;
    }
  }

  // 常驻关键词：命中就算唤醒（AI 把自己的触发词改小也不影响）
  if (Array.isArray(alwaysKeywords) && alwaysKeywords.length) {
    const text = String(plainContent || textContent || '');
    const kw = alwaysKeywords.find((k) => k && text.includes(String(k)));
    if (kw) return `always:${kw}`;
  }

  // 随机插话：lockProbability=true 时一律忽略（AI 会把自己的 probability 改回 0.05，这里兜底）
  if (!lockProbability && Number(tr.probability) > 0 && random() < Number(tr.probability)) return 'probability';

  return null;
}