// 自检报告：把"机器人现在健康吗"整理成一段人能读的文字。
//
// 危险程度说明（重要）
//   这份报告包含网关地址、队列积压、会话数、DSH 是否就绪等**内部运维信息**。
//   如果做成"所有人都能发 /自检"，等于把后台状态面板开给群里每个人——
//   轻则暴露部署细节，重则被人用来判断"什么时候动手最有效"（趁 DSH 挂了刷屏）。
//   所以：**只挂在管理员命令上**（/自检 走 isOwner 硬闸，跟 /status 同一套）。
//
//   如果确实要让群友看到健康状态，别开放完整报告，只回一行"在线/维护中"（见 shortStatus）。
//
// 设计：纯函数 + 数据注入，可离线测；不碰网络、不读全局。

const okMark = (v) => (v ? '✅' : '❌');

/** 把毫秒时长写成"3天4小时5分"这种。 */
export function humanDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  if (d > 0) return `${d}天${h}小时${m}分`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/**
 * 完整自检报告（管理员用）。
 * @param {{
 *   now?:number, startedAt?:number, mode?:string,
 *   dshReady?:boolean, snowluma?:{connected?:boolean,url?:string,lastEventAt?:number},
 *   official?:{enabled?:boolean,ready?:boolean},
 *   queues?:{queued?:number,pending?:number,deadLetters?:number},
 *   sessions?:{sizes?:Record<string,number>},
 *   people?:number, stickers?:number, reminders?:number,
 *   recentErrors?:string[]
 * }} snap
 */
export function buildSelfCheckReport(snap = {}) {
  const now = Number(snap.now) || Date.now();
  const started = Number(snap.startedAt) || 0;
  const lines = [];
  lines.push('【自检】');
  // 版本 + state schema：升级排查第一句就是"你现在跑的是哪版"
  const ver = String(snap.version || '').trim();
  const schema = snap.schemaVersion != null ? `（schema v${snap.schemaVersion}）` : '';
  lines.push(`· 版本：${ver || '未知'}${schema}`);
  lines.push(`· 运行：${started ? humanDuration(now - started) : '未知'}（模式 ${snap.mode || '?'}）`);
  lines.push(`· DSH：${okMark(snap.dshReady)}${snap.dshReady ? '' : '（模型连不上，回复会全部卡住）'}`);

  const sl = snap.snowluma || {};
  const slAge = sl.lastEventAt ? now - Number(sl.lastEventAt) : null;
  lines.push(`· 网关(SnowLuma)：${okMark(sl.connected)}${sl.connected ? '' : '（收不到群消息）'}${slAge !== null ? `，上次消息 ${humanDuration(slAge)} 前` : ''}`);

  // 重连次数：只在实际发生过时显示（0 次说"重连 0 次"是噪音）
  const reconnects = Number(sl.reconnects) || 0;
  if (reconnects > 0) {
    const lossAge = sl.lastLossAt ? now - Number(sl.lastLossAt) : null;
    lines.push(`· 网关重连：⚠️ ${reconnects} 次${lossAge !== null ? `（最近 ${humanDuration(lossAge)} 前）` : ''}`);
  }

  const off = snap.official || {};
  if (off.enabled) lines.push(`· 官方通道：${okMark(off.ready)}${off.ready ? '' : '（官方消息收发不可用）'}`);

  const q = snap.queues || {};
  const queuedN = Number(q.queued) || 0;
  const pendingN = Number(q.pending) || 0;
  const deadN = Number(q.deadLetters) || 0;
  const qParts = [`待处理 ${queuedN}`, `挂起 ${pendingN}`];
  if (deadN) qParts.push(`死信 ${deadN}`);
  const qBad = queuedN > 20 || pendingN > 20 || deadN > 0;
  lines.push(`· 队列：${qBad ? '⚠️' : '✅'} ${qParts.join(' / ')}`);

  const sizes = (snap.sessions && snap.sessions.sizes) || {};
  const sessionTotal = Object.values(sizes).reduce((a, b) => a + (Number(b) || 0), 0);
  if (sessionTotal > 0) {
    const top = Object.entries(sizes)
      .filter(([, v]) => Number(v) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(`· 会话表：✅ ${sessionTotal} 条（${top}）`);
  }

  // 抖音 cookies：解析链接的前提。剩几天这种信息一定要主动说，
  // 否则等到失效那天才发现，链接解析全挂。
  const dy = snap.douyin;
  if (dy && (dy.healthy !== undefined || dy.remaining)) {
    if (dy.healthy === false) {
      lines.push(`· 抖音 cookies：❌ ${dy.code || '失效'}${dy.message ? `（${String(dy.message).slice(0, 40)}）` : ''}`);
    } else {
      const warn = dy.code === 'cookie-aging' ? '⚠️' : '✅';
      // earliestExpiry 是"最早过期的那一条"，可能是长尾里的个别 cookie；
      // 同时给出临期条数/总数，避免看到"不到 1 小时"就以为整份凭证要废了。
      const soon = Number(dy.expiringSoon) || 0;
      const total = Number(dy.total) || 0;
      const detail = soon > 0 && total > 0 ? `（最早剩余 ${dy.remaining || '未知'}；${soon}/${total} 条临期）`
        : ` 剩余 ${dy.remaining || '未知'}`;
      lines.push(`· 抖音 cookies：${warn}${detail}`);
    }
  }

  // yt-dlp：视频链接功能全靠它。没装就是"贴链接必失败"，要提前说，而不是等报错。
  const yt = snap.ytdlp;
  if (yt !== undefined && yt !== null) {
    if (yt.available) {
      lines.push(`· yt-dlp：✅ ${yt.version || '版本未知'}${yt.path ? `（${String(yt.path).replace(/\\/g, '/')}）` : ''}`);
    } else {
      lines.push('· yt-dlp：❌ 不可用 —— 视频链接功能会直接拒绝（装一份或在 socialV2.media.video.links.ytdlpPath 指定路径）');
    }
  }

  const counts = [];
  if (Number.isFinite(snap.people)) counts.push(`人物 ${snap.people}`);
  if (Number.isFinite(snap.stickers)) counts.push(`表情 ${snap.stickers}`);
  if (Number.isFinite(snap.reminders)) counts.push(`提醒 ${snap.reminders}`);
  if (counts.length) lines.push(`· 数据：${counts.join(' / ')}`);

  const errs = Array.isArray(snap.recentErrors) ? snap.recentErrors.filter(Boolean).slice(-3) : [];
  if (errs.length) {
    lines.push('· 最近错误：');
    for (const e of errs) lines.push(`  - ${String(e).slice(0, 80)}`);
  } else {
    lines.push('· 最近错误：✅ 无');
  }
  return lines.join('\n');
}

/** 群友可见的极简状态（只回一行，不暴露内部）。 */
export function shortStatus(snap = {}) {
  const okAll = snap.dshReady !== false && (snap.snowluma ? snap.snowluma.connected !== false : true);
  return okAll ? '在线' : '在维护中，可能回复不及时';
}