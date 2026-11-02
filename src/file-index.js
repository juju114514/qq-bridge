// 本机文件索引（0.5.49 · P3）
//
// 借来的原则（arcdream-hub）：索引**只存元数据**（路径/文件名/目录/后缀/大小/时间/根目录），
// 不读文件内容 —— 索引小、扫得快、隐私面小。搜索走一个端点，网页/聊天/插件共用。
//
// 实现用 Node 自带的 `node:sqlite`（22.5+ 内置，不需要 npm 依赖，手机上也一样）。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SKIP = new Set([
  'node_modules', '.git', '.svn', '__pycache__', '.venv', 'venv',
  'dist', 'build', 'out', '.cache', 'AppData', '.dsh-office', '.dsh-spill'
]);

/** 这些后缀不索引（噪声大、数量多） */
const SKIP_EXT = new Set(['.tmp', '.log', '.lock', '.part', '.crdownload']);

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

/**
 * @param {{dbFile:string, skipDirs?:Iterable<string>, maxFiles?:number, log?:Function}} opts
 */
export function createFileIndex(opts = {}) {
  const { dbFile, maxFiles = 200000, log = () => {} } = opts;
  const skipDirs = new Set([...DEFAULT_SKIP, ...(opts.skipDirs || [])]);
  const state = { running: false, scanned: 0, roots: [], startedAt: 0, finishedAt: 0, error: '' };

  let db = null;
  async function open() {
    if (db) return db;
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    db = new DatabaseSync(dbFile);
    db.exec(`CREATE TABLE IF NOT EXISTS files(
      path TEXT PRIMARY KEY, name TEXT, dir TEXT, ext TEXT,
      size INTEGER, mtime INTEGER, root TEXT, project TEXT)`);
    db.exec('CREATE INDEX IF NOT EXISTS files_name ON files(name)');
    db.exec('CREATE INDEX IF NOT EXISTS files_root ON files(root)');
    return db;
  }

  /** 扫描一个根目录；返回写入条数。忽略权限错误，不中断。 */
  async function scan(roots = []) {
    if (state.running) return { ok: false, error: '已经在扫了' };
    const list = (Array.isArray(roots) ? roots : [roots]).filter((r) => r && fs.existsSync(r));
    if (!list.length) return { ok: false, error: '没有可扫描的目录（fileIndex.roots 为空或不存在）' };

    state.running = true; state.scanned = 0; state.roots = list; state.startedAt = Date.now(); state.error = '';
    const conn = await open();
    const insert = conn.prepare('INSERT OR REPLACE INTO files(path,name,dir,ext,size,mtime,root,project) VALUES(?,?,?,?,?,?,?,?)');
    const tx = () => { try { conn.exec('BEGIN'); } catch { /* ignore */ } };
    const commit = () => { try { conn.exec('COMMIT'); } catch { /* ignore */ } };
    tx();

    try {
      for (const root of list) {
        const project = path.basename(root);
        const stack = [root];
        while (stack.length) {
          const dir = stack.pop();
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (skipDirs.has(e.name) || e.name.startsWith('.')) continue;
              stack.push(full);
              continue;
            }
            if (!e.isFile()) continue;
            const ext = extOf(e.name);
            if (SKIP_EXT.has(ext)) continue;
            let st;
            try { st = fs.statSync(full); } catch { continue; }
            insert.run(full, e.name, dir, ext, st.size, Math.round(st.mtimeMs), root, project);
            state.scanned += 1;
            if (state.scanned >= maxFiles) { log(`[index] 到达上限 ${maxFiles}，停止`); stack.length = 0; break; }
          }
          if (state.scanned % 500 === 0) commit(), tx();
        }
      }
      commit();
      state.finishedAt = Date.now();
      log(`[index] 扫描完成：${state.scanned} 个文件，${list.length} 个根目录`);
      return { ok: true, scanned: state.scanned, roots: list };
    } catch (error) {
      try { commit(); } catch { /* ignore */ }
      state.error = String(error?.message ?? error);
      log(`[index] 扫描失败：${state.error}`);
      return { ok: false, error: state.error };
    } finally {
      state.running = false;
    }
  }

  /** 按文件名/路径模糊搜（不区分大小写），返回元数据 */
  async function search(q, { limit = 20, root = '' } = {}) {
    const term = String(q || '').trim();
    if (!term) return [];
    const conn = await open();
    const like = `%${term.replace(/[%_]/g, (m) => '\\' + m)}%`;
    const lim = Math.min(200, Math.max(1, Number(limit) || 20));
    const rows = root
      ? conn.prepare(`SELECT path,name,dir,ext,size,mtime,root FROM files
          WHERE (name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\') AND root = ?
          ORDER BY mtime DESC LIMIT ?`).all(like, like, root, lim)
      : conn.prepare(`SELECT path,name,dir,ext,size,mtime,root FROM files
          WHERE name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
          ORDER BY mtime DESC LIMIT ?`).all(like, like, lim);
    return rows.map((r) => ({ ...r }));
  }

  async function stats() {
    const conn = await open();
    const total = conn.prepare('SELECT COUNT(*) AS n FROM files').get()?.n || 0;
    return { total, ...state };
  }

  async function clear() {
    const conn = await open();
    conn.exec('DELETE FROM files');
    state.scanned = 0;
    return { ok: true };
  }

  return { scan, search, stats, clear, _state: state };
}
