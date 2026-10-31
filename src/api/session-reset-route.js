// POST /api/sessions/reset —— 一键重置某个会话（可选先备份）（0.4.91）
//
// 为什么要这个按钮：改完人格/预设后，正在进行的 QQ 会话还在用旧 preset，
// 控制台上那句提示是"需重置该会话或重启 DSH"——但重置只能去 QQ 里发 /reset。
// 这里给一个按钮，并允许**先备份再重置**（重置会丢掉这轮上下文，不是谁都愿意）。
//
// 契约：
//   POST { key, backup?: boolean }
//   → { ok, key, backupPath?, note }
import fs from 'node:fs';
import path from 'node:path';

/** 把会话 key 变成安全文件名：group:123 → group_123 */
function safeKeyName(key) {
  return String(key || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

function backupFileName(key, now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${safeKeyName(key)}-${stamp}.json`;
}

export async function handleSessionResetRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/sessions/reset') return false;
  if (req.method !== 'POST') { sendJson({ ok: false, error: '只支持 POST' }, 405); return true; }

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const body = (await (ctx.readBody || d.readBody)?.()) || {};
  const key = String(body.key || '').trim();
  const backup = body.backup !== false; // 默认备份（丢了就找不回来）

  if (!/^(group|private):[A-Za-z0-9_-]+$/.test(key)) {
    sendJson({ ok: false, error: 'key 形如 group:123 或 private:456' }, 400);
    return true;
  }
  if (typeof d.resetConversation !== 'function') {
    sendJson({ ok: false, error: '当前版本不支持重置（resetConversation 未注入）' }, 501);
    return true;
  }

  let backupPath = '';
  if (backup && typeof d.snapshotConversation === 'function') {
    try {
      const snapshot = d.snapshotConversation(key);
      const dir = d.files?.sessionBackups || '';
      if (dir && snapshot) {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, backupFileName(key));
        fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
        backupPath = file;
      }
    } catch (error) {
      // 备份失败就**不重置**：宁可报错，也不要在没备份的情况下把上下文删掉
      sendJson({ ok: false, error: `备份失败，已中止重置：${error?.message ?? error}` }, 500);
      return true;
    }
  }

  try {
    const r = await d.resetConversation(key);
    // 没有活动会话 = 已经重置过（或还没开始聊）→ 幂等成功，别报错吓人
    if (r && r.ok === false && r.reason === 'no-session') {
      sendJson({ ok: true, key, backupPath, note: '该会话当前没有活动上下文（可能已重置过），无需再重置' });
      return true;
    }
    if (r && r.ok === false) {
      sendJson({ ok: false, error: String(r.error || '重置失败'), backupPath }, 502);
      return true;
    }
    sendJson({
      ok: true,
      key,
      backupPath,
      note: backupPath ? '已备份并重置，下条消息会开新上下文' : '已重置（未备份），下条消息会开新上下文'
    });
  } catch (error) {
    sendJson({ ok: false, error: `重置失败：${error?.message ?? error}`, backupPath }, 502);
  }
  return true;
}
