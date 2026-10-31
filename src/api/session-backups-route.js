// 会话备份列表（0.4.93）
//
// 起因：0.4.91 加了「重置会话（可先备份）」，但备份写进 state/session-backups/ 之后就没人看得见——
// 用户说"可以识别之前的对话备份到一个模块，防止找不到"。这里给出列表 / 详情 / 删除。
//
// 契约：
//   GET    /api/session-backups             → { ok, dir, count, items:[{file,key,at,size,messages}] }
//   GET    /api/session-backups?file=x.json → { ok, item, snapshot }   （内容预览，最多 50 条消息）
//   DELETE /api/session-backups?file=x.json → { ok, removed }
import fs from 'node:fs';
import path from 'node:path';
import { buildRestorePatch, restorableCount } from '../session-backup-restore.js';

const MAX_ITEMS = 200;
const PREVIEW_MESSAGES = 50;

/** 只允许纯文件名，挡住 ../ 与绝对路径 */
function isSafeBackupName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 120
    && /^[A-Za-z0-9._-]+\.json$/.test(name)
    && !name.includes('..');
}

function summarize(file, dir) {
  const full = path.join(dir, file);
  const st = fs.statSync(full);
  let snapshot = null;
  try {
    snapshot = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    snapshot = null;
  }
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const recover = restorableCount(snapshot || {});
  return {
    file,
    key: String(snapshot?.key || ''),
    at: Number(snapshot?.at || st.mtimeMs || 0),
    size: st.size,
    messages: messages.length,
    restorable: recover.recent,
    restorableUnread: recover.unread,
    longTerm: Array.isArray(snapshot?.longTerm) ? snapshot.longTerm.length : 0,
    broken: !snapshot
  };
}

export async function handleSessionBackupsRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/session-backups') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const dir = d.files?.sessionBackups || '';
  if (!dir) { sendJson({ ok: false, error: '未配置备份目录' }, 500); return true; }

  const file = url.searchParams.get('file') || '';

  if (req.method === 'GET' && !file) {
    let items = [];
    try {
      if (fs.existsSync(dir)) {
        items = fs.readdirSync(dir)
          .filter((f) => isSafeBackupName(f))
          .map((f) => { try { return summarize(f, dir); } catch { return null; } })
          .filter(Boolean)
          .sort((a, b) => b.at - a.at)
          .slice(0, MAX_ITEMS);
      }
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      return true;
    }
    sendJson({ ok: true, dir, count: items.length, items });
    return true;
  }

  if (!isSafeBackupName(file)) { sendJson({ ok: false, error: '文件名不合法' }, 400); return true; }

  const full = path.join(dir, file);

  if (req.method === 'POST') {
    const body = (await (ctx.readBody)?.()) || {};
    if (body.action === 'trimUnread') {
      let snap = null;
      try { snap = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 忽略 */ }
      if (!snap || !Array.isArray(snap.unread)) { sendJson({ ok: false, error: '备份里没有未读列表' }, 400); return true; }
      if (typeof d.restoreConversation !== 'function') { sendJson({ ok: false, error: '当前版本不支持' }, 501); return true; }
      let live = {};
      try {
        const rawLive = typeof d.readFile === 'function' ? d.readFile(d.files?.socialV2 || '') : '';
        if (rawLive) live = (JSON.parse(rawLive.replace(/^\uFEFF/, ''))?.conversations?.[String(snap.key || '')]) || {};
      } catch { /* 忽略 */ }
      const ids = new Set(snap.unread.map((x) => `${x.messageId ?? ''}|${x.seq ?? ''}`));
      const kept = (Array.isArray(live.unread) ? live.unread : []).filter((x) => !ids.has(`${x.messageId ?? ''}|${x.seq ?? ''}`));
      const removed = (live.unread || []).length - kept.length;
      d.restoreConversation(String(snap.key || ''), { recentMessages: live.recentMessages, unread: kept });
      sendJson({ ok: true, removed, totalUnread: kept.length });
      return true;
    }
    if (body.action !== 'restore') { sendJson({ ok: false, error: "只支持 action:'restore' / 'trimUnread'" }, 400); return true; }
    let snapshot = null;
    try {
      snapshot = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      sendJson({ ok: false, error: `备份读不出来：${error?.message ?? error}` }, 400);
      return true;
    }
    if (typeof d.restoreConversation !== 'function') {
      sendJson({ ok: false, error: '当前版本不支持恢复（restoreConversation 未注入）' }, 501);
      return true;
    }
    const key = String(snapshot?.key || '');
    if (!/^(group|private):[A-Za-z0-9_-]+$/.test(key)) {
      sendJson({ ok: false, error: '备份里的会话 key 不合法，拒绝恢复' }, 400);
      return true;
    }
    // 当前会话（可能已存在），用于合并去重
    let live = {};
    try {
      const rawLive = typeof d.readFile === 'function' ? d.readFile(d.files?.socialV2 || '') : '';
      if (rawLive) {
        const parsed = JSON.parse(rawLive.replace(/^\uFEFF/, ''));
        live = parsed?.conversations?.[key] || {};
      }
    } catch { /* 读不到就当空的 */ }
    const patch = buildRestorePatch({ snapshot, live, includeUnread: body.includeUnread === true });
    try {
      const applied = d.restoreConversation(key, patch);
      sendJson({
        ok: true,
        key,
        file,
        addedRecent: patch.addedRecent,
        addedUnread: patch.addedUnread,
        totalRecent: applied?.recent ?? patch.recentMessages.length,
        totalUnread: applied?.unread ?? patch.unread.length,
        note: `已恢复 ${patch.addedRecent} 条历史 / ${patch.addedUnread} 条未读（与现有记录去重后合并）`
      });
    } catch (error) {
      sendJson({ ok: false, error: `恢复失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  if (req.method === 'GET') {
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const snapshot = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
      sendJson({
        ok: true,
        file,
        item: summarize(file, dir),
        snapshot: {
          key: snapshot?.key ?? '',
          at: snapshot?.at ?? 0,
          sessionId: snapshot?.sessionId ?? null,
          role: snapshot?.role ?? null,
          model: snapshot?.model ?? null,
          messages: messages.slice(-PREVIEW_MESSAGES),
          truncated: messages.length > PREVIEW_MESSAGES,
          longTerm: Array.isArray(snapshot?.longTerm) ? snapshot.longTerm.slice(0, 20) : []
        }
      });
    } catch (error) {
      sendJson({ ok: false, error: `读不出来：${error?.message ?? error}` }, 404);
    }
    return true;
  }

  if (req.method === 'DELETE') {
    try {
      fs.rmSync(full, { force: true });
      sendJson({ ok: true, removed: file });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  }

  sendJson({ ok: false, error: '只支持 GET / DELETE' }, 405);
  return true;
}
