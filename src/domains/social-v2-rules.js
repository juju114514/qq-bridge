// 社交模式（reserved2）的纯规则：说话人名单、退场判定、沉睡判定、唤醒安全性。
//
// 波次 1 第二个域。选这四个函数的理由：它们**没有任何副作用**，
// 但每一个都对应一次线上事故，而且都留在 bridge 里没法单独测。
//
//   1. 指定群友发言名单：脏数据（"null"/对象/负数）会被当成可唤醒条件 → 绕过"防永眠"
//   2. 退场判定：只有**最后一条别人说的话**算数（自己的话不算，历史消息更不算）
//   3. 沉睡判定：diving 且非 anyMessage 就是"沉睡中"，必须先观察才能再睡
//   4. 唤醒安全性：没有硬触发器 + 没有定时 + 概率为 0 → "永眠"，要提示

/** 归一化"指定群友发言唤醒"名单：只留正整数 QQ 号、去重、最多 20 个。 */
export function normalizeSpeakerIds(value, { max = 20 } = {}) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
  const seen = new Set();
  const clean = [];
  for (const v of list) {
    const s = String(v ?? '').trim();
    if (!/^[1-9]\d*$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    clean.push(s);
    if (clean.length >= max) break;
  }
  return clean;
}

/**
 * 最后一条**别人**说的话是否在道别。
 * 注意只看最后一条（自己的、更早的都不算），否则历史里的"晚安"会让每轮都被判成退场。
 */
export function hasExplicitEnd(st, explicitEndRe) {
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const last = [...recent].reverse().find((m) => m && !m.isSelf);
  if (!last) return false;
  if (!(explicitEndRe instanceof RegExp)) return false;
  return explicitEndRe.test(String(last.tail || last.plain || last.text || ''));
}

/** diving 且不是 anyMessage → 视为"沉睡/潜水"（要先观察才能再睡）。 */
export function isSleepingConfig(wc) {
  if (!wc) return false;
  if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
  return true;
}

/**
 * 评估当前 WakeConfig 的"唤醒安全性"：
 *   hard        有明确触发器（@ / 名字 / 关键词 / 指定人 / 拍一拍 / 提问）
 *   timed       有限潜水且还没到期
 *   soft        概率唤醒（>0）
 *   guaranteed  hard || timed || soft —— 只要有一个就不算永眠
 *   stale       配置超过 24 小时没确认过（提示 AI 该复核）
 */
export function computeWakeSafety(wc, { now = Date.now() } = {}) {
  const tr = wc?.triggers || {};
  const hard = Boolean(
    wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
    (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
    normalizeSpeakerIds(tr.speakerIds).length > 0
  );
  const timed = Boolean(!wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > now);
  const soft = Number(tr.probability) > 0;
  const guaranteed = hard || timed || soft;
  const confirmedNum = Number(wc?.confirmedAt);
  const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || now - confirmedNum > 24 * 60 * 60 * 1000;
  return { hard, timed, soft, guaranteed, stale };
}