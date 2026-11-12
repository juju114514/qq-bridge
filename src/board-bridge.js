// 桌面看板联动（room-pet）
// 作用：把「收到消息 / 准备回复 / 回复完成」三个时机推给本地看板
// 配置：config.json 里 board.*
// 失败一律静默，绝不影响 QQ 主链路。
//
// 群多时的过滤（board.rules）：
//   private         私聊是否触发          默认 true
//   mention         群里 @/引用 是否触发   默认 true
//   keyword         群里命中关键词是否触发 默认 true
//   ambientRate     群里普通消息采样率     默认 0.05
//   perGroupCooldownMs  同群最短间隔       默认 60000
//   muted           静音群列表
//   names           被叫的名字（命中算 mention）

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { URL } from 'node:url';

// 调试日志：默认落在仓库 state/ 下（可执行目录即仓库根），可用 QQB_BOARD_LOG 覆盖；
// 原来写死成作者本机的 D:/QQBot-open/... —— 公开仓库里不该出现别人的绝对路径
const DEBUG_LOG = process.env.QQB_BOARD_LOG || path.resolve('state', 'board-side.log');
const IDLE_DELAY_MS = 6000;

function dbg(line) {
  try { fs.appendFileSync(DEBUG_LOG, new Date().toTimeString().slice(0, 8) + ' ' + line + '\n'); } catch {}
}
const THINK_TIMEOUT_MS = 9000; // 只思考没回复 → 自动回待机

export function createBoardBridge({ getConfig = () => ({}), log = () => {} } = {}) {
  let idleTimer = null;
  let thinkTimer = null;
  let warned = false;
  const lastGroupAt = new Map(); // groupId -> ts

  function conf() {
    const c = (getConfig() && getConfig()) || {};
    const b = c.board || {};
    const r = b.rules || {};
    return {
      enabled: b.enabled === true,
      url: String(b.url || 'http://127.0.0.1:8796/state'),
      maxChars: Number(b.maxChars) || 80,
      rules: {
        private: r.private !== false,
        mention: r.mention !== false,
        keyword: r.keyword !== false,
        ambientRate: Number.isFinite(Number(r.ambientRate)) ? Number(r.ambientRate) : 0.05,
        perGroupCooldownMs: Number(r.perGroupCooldownMs) || 60000,
        muted: Array.isArray(r.muted) ? r.muted.map(String) : [],
        keywords: Array.isArray(r.keywords) ? r.keywords.map(String) : [],
        names: Array.isArray(r.names) ? r.names.map(String) : [],
        replyWaitMs: Number(r.replyWaitMs) || THINK_TIMEOUT_MS,
      },
    };
  }

  function textOf(event) {
    if (!event) return '';
    if (typeof event.raw_message === 'string') return event.raw_message;
    if (Array.isArray(event.message)) {
      return event.message
        .map((seg) => (seg && seg.type === 'text' && seg.data && seg.data.text) || '')
        .join('');
    }
    return '';
  }

  function isMentioned(event, rules) {
    const self = String(event?.self_id ?? '');
    if (Array.isArray(event?.message)) {
      for (const seg of event.message) {
        if (seg?.type === 'at' && self && String(seg?.data?.qq ?? '') === self) return true;
        if (seg?.type === 'reply') return true; // 引用她
      }
    }
    const t = textOf(event);
    for (const n of rules.names) if (n && t.includes(n)) return true;
    for (const k of rules.keywords) if (k && t.includes(k)) return true;
    return rules.keywords.length > 0 && rules.keywords.some((k) => t.includes(k));
  }

  /** 是否值得让看板动一下 */
  function gate({ kind, id, event }) {
    const c = conf();
    if (!c.enabled) { dbg('gate disabled'); return false; }
    dbg('gate ' + kind + ' id=' + id);
    const rules = c.rules;
    // 私聊
    if (kind === 'private') return rules.private;
    // 群聊
    if (rules.muted.includes(String(id))) return false;

    const now = Date.now();
    // 被点名/关键词：不受冷却限制（她真的被叫了就该有反应）
    if (rules.mention && isMentioned(event, rules)) {
      lastGroupAt.set(String(id), now);
      return true;
    }
    // 普通群聊：先看同群冷却，再概率采样
    const last = lastGroupAt.get(String(id)) || 0;
    if (now - last < rules.perGroupCooldownMs) return false;
    if (Math.random() < rules.ambientRate) {
      lastGroupAt.set(String(id), now);
      return true;
    }
    return false;
  }

  function post(state, text = '') {
    const c = conf();
    if (!c.enabled) return;
    let u;
    try {
      u = new URL(c.url);
    } catch {
      return;
    }
    dbg('post ' + state + ' ' + String(text || '').slice(0, 20));
    const body = Buffer.from(
      JSON.stringify({ state, text: String(text || '').slice(0, c.maxChars) }),
      'utf8'
    );
    try {
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port || 80,
          path: u.pathname + (u.search || ''),
          method: 'POST',
          timeout: 1200,
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        },
        (res) => res.resume()
      );
      req.on('timeout', () => req.destroy());
      req.on('error', (err) => {
        if (!warned) {
          warned = true;
          log(`桌面看板推送失败（后续静默）：${err?.message || err}`);
        }
      });
      req.write(body);
      req.end();
    } catch {
      /* 推送失败不影响 QQ */
    }
  }

  return {
    gate,
    thinking() {
      clearTimeout(idleTimer);
      post('thinking');
      clearTimeout(thinkTimer);
      const wait = conf().rules.replyWaitMs;
      thinkTimer = setTimeout(() => post('idle'), Math.max(1500, wait));
      if (thinkTimer.unref) thinkTimer.unref();
    },
    speaking(text) {
      clearTimeout(idleTimer);
      clearTimeout(thinkTimer);
      post('speaking', text);
    },
    idle(delay = IDLE_DELAY_MS) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => post('idle'), Math.max(1000, delay));
      if (idleTimer.unref) idleTimer.unref();
    },
    post,
  };
}
