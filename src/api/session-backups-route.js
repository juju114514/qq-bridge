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
  return {
    file,
    key: String(snapshot?.key || ''),
    at: Number(snapshot?.at || st.mtimeMs || 0),
    size: st.size,
    messages: messages.length,
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
