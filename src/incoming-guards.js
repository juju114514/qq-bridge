// 入站"闸门"：这条消息要不要继续往下走（引用解析 → 空文本兜底 → 待答 → 静默）。
//
// 为什么单独一块：
//   这四步都是"决定 stop 还是 continue"，顺序一旦错就会漏消息或吞消息：
//     · 先解析引用：只引用机器人自己、不附文字，也算在叫它
//     · 再兜底空文本：官方通道"只 @ 一下"的消息不能当空消息丢掉
//     · 再看待答：有挂起提问时先当回答处理（只有管理员能消费审批）
//     · 最后静默：群友消息在静默模式下只记录不投递
//
// 返回值统一：{ stop:true, reason } 或 { stop:false, plainContent, isOwner, roleState }

export function createIncomingGuards(deps = {}) {
  const {
    log = () => {}, appendActivity = () => {},
    getCfg, isSessionAllowedInCurrentMode, isQuoteTargetSelf,
    rememberPersonInMessage, readRoleState, handlePendingAnswer, pending
  } = deps;

  async function gate(ctx = {}) {
    const { key, kind, id, event } = ctx;
    let plainContent = ctx.plainContent;
    const textContent = ctx.textContent;
    const cfg = getCfg();

    // ① 引用对象是机器人自己时视为"直接对它说"，所以**先**解析再做空文本过滤
    const quoteTargetIsSelf = await isQuoteTargetSelf(event?.message ?? [], kind, id, event?.self_id);
    if (typeof isSessionAllowedInCurrentMode === 'function' && !isSessionAllowedInCurrentMode(key)) {
      return { stop: true, reason: 'mode' };
    }

    // ② 官方通道常见形态：只 @ 了一下没打字 —— 不能当空消息丢弃
    if (!plainContent && event?.__official?.atBot === true) {
      const att = Array.isArray(event?.__official?.attachments) ? event.__official.attachments.length : 0;
      plainContent = att > 0
        ? `（在群里 @ 了我，没打字，但带了 ${att} 个附件）`
        : '（在群里 @ 了我，但这次没打字）';
    }
    if (!plainContent && !quoteTargetIsSelf) {
      if (String(key).includes('official-')) log(`[official] 消息为空且不是 @/引用，丢弃：${key}`);
      return { stop: true, reason: 'empty' };
    }

    // owner 判定要同时支持两种身份：
    //   · 个人号：QQ 号（数字）
    //   · 官方通道：openid（官方事件里没有 QQ 号）
    //   见 docs/audits/official-channel-audit-2026-10-31.md 缺口 2
    const senderRaw = String(event?.user_id ?? '');
    const ownerQQNum = String(cfg?.ownerQQ ?? '');
    const ownerOpenid = String(cfg?.official?.ownerOpenid ?? '').trim();
    const isOwner = Boolean((ownerQQNum && senderRaw === ownerQQNum)
      || (ownerOpenid && senderRaw.replace(/^official-/, '') === ownerOpenid));
    rememberPersonInMessage?.(kind, id, event);
    const roleState = typeof readRoleState === 'function' ? readRoleState() : { mode: 'active' };

    // ③ 有挂起的提问/审批：先当回答处理（审批只有管理员能消费）
    const p = pending?.get?.(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer?.(p, plainContent, key, isOwner);
      return { stop: true, reason: 'pending-answer' };
    }

    // ④ 静默模式：群友消息只记录不投递；管理员照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event?.user_id}：${String(textContent ?? '').slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return { stop: true, reason: 'silent' };
    }

    // quoteTargetIsSelf 后续还要用（唤醒判定里"是否在叫它"），一并返回
    return { stop: false, plainContent, isOwner, roleState, quoteTargetIsSelf };
  }

  return { gate };
}