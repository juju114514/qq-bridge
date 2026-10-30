// 定时任务的控制台接口：/api/scheduler*
//
// 引擎来自 D:\repo-refs\hdace-dsh-qq（同源 MIT 分叉），已经搬到 src/scheduler/。
// 这个文件只做三件事：**建实例、分派路由、把桥接能力注入进去**。
//
// 注入的四个关键依赖（引擎不关心 QQ 细节）：
//   deliver(targetKey, payload)     真正把内容发出去
//   validateTarget(targetKey)        目标必须在白名单内（防止定时任务给陌生人发消息）
//   ownerKey()                       管理员私聊 key（"只发给我"用）
//   onAiAsk(...)                     kind='ai' 时叫 AI 来说（由 bridge 的 deliverPrompt 实现）

import path from 'node:path';
import { getSchedulerInstance } from '../scheduler/instance.js';

export function createSchedulerRoutes(baseDeps = {}) {
  const {
    log = () => {},
    stateDir,
    getCfg,
    deliverPrompt,
    allowed,
    resolveMode = () => ''
  } = baseDeps;

  let scheduler = null;

  function ownerKey() {
    const cfg = getCfg();
    const owner = String(cfg?.ownerQQ ?? '').trim();
    return owner ? `private:${owner}` : '';
  }

  // 注意：引擎约定 validateTarget 返回**错误字符串**（空串/假值 = 通过），
  // 不是布尔值。第一次接的时候写成 return true/false，结果所有任务都登记失败。
  function validateTarget(key) {
    const m = /^(group|private):(\d{5,12})$/.exec(String(key ?? ''));
    if (!m) return '发送对象格式应为 group:<群号> 或 private:<QQ号>';
    const cfg = getCfg();
    if (key === ownerKey()) return '';
    return allowed?.(m[1], Number(m[2]), cfg) ? '' : '目标不在白名单内（定时任务不给陌生人发消息）';
  }

  // 引擎单例在 src/scheduler/instance.js —— 控制台与 QQ 命令必须共用同一个实例
  function getScheduler() { return getSchedulerInstance(baseDeps); }

  function targets() {
    const cfg = getCfg();
    const out = [{ key: ownerKey(), label: '管理员私聊', kind: 'owner' }];
    for (const id of (cfg?.allow?.private ?? [])) {
      if (`private:${id}` !== ownerKey()) out.push({ key: `private:${id}`, label: `好友 ${id}`, kind: 'private' });
    }
    for (const id of (cfg?.allow?.groups ?? [])) out.push({ key: `group:${id}`, label: `群 ${id}`, kind: 'group' });
    return out;
  }

  async function handle(ctx = {}) {
    // sendJson / readBody 都是**每请求**的闭包，不能从 baseDeps 拿（真实踩过：readBody is not a function）
    const { req, url, sendJson, readBody } = ctx || {};
    const s = getScheduler();
    const sub = url.pathname.slice('/api/scheduler'.length);
    const fail = (error, code = 400) => sendJson({ ok: false, error: error?.message ?? String(error) }, code);

    try {
      if (req.method === 'GET' && (sub === '' || sub === '/')) {
        sendJson({ ok: true, ...s.snapshot(), targets: targets(), writable: s.isWritable(), mode: resolveMode() });
        return true;
      }
      const body = req.method === 'GET' ? {} : await readBody();
      if (req.method === 'POST' && sub === '/settings') { sendJson({ ok: true, settings: s.updateSettings(body, { source: 'console' }) }); return true; }
      if (req.method === 'POST' && sub === '/preview') { sendJson({ ok: true, ...s.preview(body, Math.min(10, Number(body.count) || 5)) }); return true; }
      if (req.method === 'POST' && sub === '/tasks') { sendJson({ ok: true, task: s.createTask(body, { source: 'console' }) }); return true; }
      const m = /^\/tasks\/(\d+)(\/run|\/enable|\/disable)?$/.exec(sub);
      if (m) {
        const id = Number(m[1]);
        if (req.method === 'PATCH' && !m[2]) { sendJson({ ok: true, task: s.updateTask(id, body, { source: 'console' }) }); return true; }
        if (req.method === 'DELETE' && !m[2]) { sendJson({ ok: true, ...s.deleteTask(id, { source: 'console' }) }); return true; }
        if (req.method === 'POST' && m[2] === '/run') { sendJson({ ok: true, ...(await s.runNow(id, { source: 'console' })) }); return true; }
        if (req.method === 'POST' && (m[2] === '/enable' || m[2] === '/disable')) { sendJson({ ok: true, task: s.setEnabled(id, m[2] === '/enable', { source: 'console' }) }); return true; }
      }
      sendJson({ ok: false, error: '不存在的定时任务接口' }, 404);
    } catch (error) {
      fail(error);
    }
    return true;
  }

  return { handle, getScheduler, targets, validateTarget };
}