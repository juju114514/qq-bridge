// 官方通道「主动消息」：配额、定时播报、权限降级。
//
// 背景（官方文档）：
//   · 主动消息 = 不带 msg_id 发送。用户可在客户端关闭「允许主动发送」，关了之后**一律失败**。
//   · 群聊主动消息还需要群主在加机器人时勾选「主动推送消息」——不是所有群都有这个权限。
//   · 频控：群 60/分（未认证 30）、单聊 10/分；单关系 20/分；每日 1000 条/群、1000 条/用户。
//
// 所以这里的职责是：**替调用方守住配额与权限**，而不是"能发就发"。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LIMITS = Object.freeze({
  group: { perMinute: 30, perDay: 1000 },
  private: { perMinute: 20, perDay: 1000 }
});

/** 5 段 cron：分 时 日 月 周。支持 * , - / 与数字；不支持秒与 @yearly 之类。 */
export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 需要 5 段（分 时 日 月 周），实际 ${parts.length} 段`);
  const [m, h, dom, mon, dow] = parts;
  const field = (s, min, max) => {
    const set = new Set();
    for (const chunk of s.split(',')) {
      const stepSplit = chunk.split('/');
      const body = stepSplit[0];
      const step = stepSplit[1] ? Number(stepSplit[1]) : 1;
      if (!Number.isFinite(step) || step <= 0) throw new Error(`cron 步长非法：${chunk}`);
      let lo;
      let hi;
      if (body === '*') { lo = min; hi = max; } else if (body.includes('-')) {
        const [a, b] = body.split('-').map(Number);
        lo = a; hi = b;
      } else { lo = Number(body); hi = lo; }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`cron 字段越界：${chunk}（范围 ${min}-${max}）`);
      }
      for (let v = lo; v <= hi; v += step) set.add(v);
    }
    return set;
  };
  return {
    minutes: field(m, 0, 59),
    hours: field(h, 0, 23),
    doms: field(dom, 1, 31),
    months: field(mon, 1, 12),
    dows: field(dow.replace(/^7$/, '0'), 0, 6),
    domAny: dom === '*',
    dowAny: dow === '*'
  };
}

/** 给定时刻是否命中（本地时间）。日与周同时限定时按"或"处理（Vixie cron 语义）。 */
export function cronMatches(expr, date = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!c.minutes.has(date.getMinutes())) return false;
  if (!c.hours.has(date.getHours())) return false;
  if (!c.months.has(date.getMonth() + 1)) return false;
  if (c.domAny && c.dowAny) return true;
  const domHit = c.doms.has(date.getDate());
  const dowHit = c.dows.has(date.getDay());
  if (c.domAny) return dowHit;
  if (c.dowAny) return domHit;
  return domHit || dowHit;
}

/** 分钟粒度去重：同一分钟只跑一次（tick 间隔小于 60 秒时必须靠它）。 */
export function isDue(schedule, now = new Date()) {
  if (!schedule || schedule.enabled === false) return false;
  const stamp = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
  if (schedule.lastRunStamp === stamp) return false;
  try {
    return cronMatches(schedule.cron, now);
  } catch {
    return false;
  }
}

/**
 * 配额账本：按天、按会话记数；落盘到 state/official-proactive.json。
 * 失败不抛（配额是保护，不是主链路），但会返回原因让调用方决定。
 */
export class QuotaBook {
  constructor(file, limits = DEFAULT_LIMITS) {
    this.file = file;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.state = { day: '', counts: {} };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      if (raw && typeof raw === 'object') this.state = { day: String(raw.day ?? ''), counts: raw.counts ?? {} };
    } catch { /* 文件不存在/损坏都从空账本开始 */ }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state), 'utf8');
    } catch { /* 落盘失败不影响发送决策 */ }
  }

  dayKey(now = new Date()) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  /** 预占一次配额；不够就返回 { ok:false, reason }。 */
  take(kind, key, now = new Date()) {
    const day = this.dayKey(now);
    if (this.state.day !== day) { this.state = { day, counts: {} }; }
    const limit = this.limits[kind] ?? this.limits.group;
    const rec = this.state.counts[key] ?? { day: 0, minute: 0, minuteAt: 0 };
    const minuteStamp = Math.floor(now.getTime() / 60000);
    if (rec.minuteAt !== minuteStamp) { rec.minuteAt = minuteStamp; rec.minute = 0; }
    if (rec.day >= limit.perDay) return { ok: false, reason: `今日主动消息已达上限（${limit.perDay} 条/${kind === 'group' ? '群' : '用户'}）` };
    if (rec.minute >= limit.perMinute) return { ok: false, reason: `本分钟主动消息已达上限（${limit.perMinute} 条）` };
    rec.day += 1;
    rec.minute += 1;
    this.state.counts[key] = rec;
    this.save();
    return { ok: true, used: { day: rec.day, minute: rec.minute }, limits: limit };
  }

  snapshot() {
    return { day: this.state.day, counts: { ...this.state.counts }, limits: this.limits };
  }
}

/**
 * 定时播报器：注入 send(kind, id, text) 即可，不直接依赖官方客户端。
 * 只做"到点就调 send"，配额与权限由调用方在 send 里处理。
 */
export class ProactiveScheduler {
  constructor({ schedules = [], log = () => {}, now = () => new Date(), tickMs = 20000 } = {}) {
    this.schedules = schedules.map((s) => ({ ...s }));
    this.log = log;
    this.now = now;
    this.tickMs = tickMs;
    this.timer = null;
  }

  due(nowDate = this.now()) {
    return this.schedules.filter((s) => isDue(s, nowDate));
  }

  markRun(schedule, nowDate = this.now()) {
    schedule.lastRunStamp = `${nowDate.getFullYear()}-${nowDate.getMonth() + 1}-${nowDate.getDate()} ${nowDate.getHours()}:${nowDate.getMinutes()}`;
    schedule.lastRunAt = nowDate.toISOString();
  }

  start(send) {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      for (const s of this.due()) {
        try {
          await send(s);
          this.markRun(s);
          this.log(`[official] 定时播报已发送 → ${s.key}（cron ${s.cron}）`);
        } catch (error) {
          this.markRun(s); // 失败也记一次，避免同一分钟疯狂重试
          this.log(`[official] 定时播报失败 → ${s.key}：${error?.message ?? error}`);
        }
      }
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** 把官方 API 的错误翻译成人话（权限/开关/频控是三种完全不同的处理）。 */


/**
 * 「后续聊天意向」识别：用户说出"希望以后都陪着我 / 明天见 / 下次聊"这类话时，
 * 说明他愿意再有下一次 —— 这正是**互动召回**的使用场景，可以给这个人开召回窗口。
 *
 * 只做保守命中：宁可漏，不要把普通寒暄（"在吗""哈哈"）当意向，
 * 否则等于给所有人开召回，打扰感立刻上来。
 */
export const RECALL_INTENT_PATTERNS = [
  { reason: '约定未来', re: /明天见|明天聊|明天找你|明儿见|明儿聊|下次见|下次聊|回头聊|改天聊|晚点聊|等我回来/ },
  { reason: '希望陪伴', re: /(以后|每天|一直|往后).{0,6}(陪我|陪我聊|陪着我|都在|聊|说话)|别走|不要走|常来|你会一直/ },
  { reason: '主动邀约', re: /记得找我|想聊.{0,4}(就|随时)|随时.{0,4}(找我|喊我)|有事.{0,4}找你|约好/ },
  { reason: '告别+再会', re: /(晚安|睡了|下线).{0,6}(明天|明儿|下次)/ }
];

/** 返回 { reason } 或 null（不命中）。 */
export function detectRecallIntent(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 200) return null;
  for (const p of RECALL_INTENT_PATTERNS) {
    if (p.re.test(s)) return { reason: p.reason };
  }
  return null;
}

/**
 * 互动召回窗口（官方语义：用户聊过之后 30 天内 4 个周期各 1 条）。
 *
 *   period 0：当天         period 1：1–3 天
 *   period 2：3–7 天       period 3：7–30 天
 *
 * 以**第一次成功召回**为锚点开窗；超过 30 天窗口作废、重新计时。
 * 这样即使调用方乱调，也不会把 4 条配额在一天内打光。
 */
export class RecallWindow {
  constructor(file) {
    this.file = file;
    this.state = { users: {} };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      if (raw?.users && typeof raw.users === 'object') this.state = raw;
    } catch { /* 空账本 */ }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state), 'utf8');
    } catch { /* ignore */ }
  }

  /** 当前应处于第几个周期（0..3）；超过 30 天返回 -1（窗口作废）。 */
  periodIndex(userKey, now = Date.now()) {
    const rec = this.state.users[userKey];
    if (!rec?.openedAt) return 0;
    const days = (now - Number(rec.openedAt)) / 86400000;
    if (days < 1) return 0;
    if (days < 3) return 1;
    if (days < 7) return 2;
    if (days < 30) return 3;
    return -1;
  }

  /**
   * 开启召回窗口：由"检测到后续聊天意向"触发。
   * 不动已用配额，只记下 arm 时间与原因，并确保窗口从此刻起算（若还没有窗口）。
   */
  arm(userKey, { reason = '', now = Date.now(), ttlMs = 30 * 86400000 } = {}) {
    const rec = this.state.users[userKey] ?? { openedAt: now, used: [false, false, false, false] };
    if (!rec.openedAt || now - Number(rec.openedAt) > ttlMs) rec.openedAt = now;
    rec.armedAt = now;
    rec.armedReason = String(reason ?? '');
    this.state.users[userKey] = rec;
    this.save();
    return { ok: true, period: this.periodIndex(userKey, now), reason: rec.armedReason };
  }

  /** 该用户是否被"意向"开过窗口（供状态/日志用）。 */
  armedInfo(userKey) {
    const rec = this.state.users[userKey];
    if (!rec?.armedAt) return null;
    return { armedAt: rec.armedAt, reason: rec.armedReason ?? '' };
  }

  /** 预占一次召回；成功返回 { ok, period }，否则给原因。 */
  claim(userKey, now = Date.now()) {
    const period = this.periodIndex(userKey, now);
    if (period < 0) {
      // 窗口过期：重新开窗，从周期 0 开始
      this.state.users[userKey] = { openedAt: now, used: [true, false, false, false] };
      this.save();
      return { ok: true, period: 0, reopened: true };
    }
    const rec = this.state.users[userKey] ?? { openedAt: now, used: [false, false, false, false] };
    if (rec.used?.[period]) {
      return { ok: false, reason: `这个周期的召回已用过（第 ${period + 1} 个周期），等下个周期再发` };
    }
    rec.used[period] = true;
    rec.lastAt = now;
    this.state.users[userKey] = rec;
    this.save();
    return { ok: true, period };
  }

  snapshot() {
    return { users: { ...this.state.users } };
  }
}

export function explainProactiveError(message) {
  const text = String(message ?? '');
  if (/11000|30600[01]|主动消息|no permission|permission denied/i.test(text)) {
    return '主动消息被拒：多半是群主没有勾选「主动推送消息」权限（或该群不支持）。请让群主在群机器人设置里打开；个人主体只能给自建群开。';
  }
  if (/用户.*关闭|not allowed|disabled/i.test(text)) {
    return '对方关闭了「允许主动发送」：这是用户的否决权，无法绕过，只能等他先说话。';
  }
  if (/频率|too many|rate|1200|2200/i.test(text)) {
    return '触发频控：降低频率或等一分钟再试。';
  }
  return '';
}
