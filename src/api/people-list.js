// 控制台：人物库列表（GET /api/socialV2/people）。
//
// 背景：人物库后端（src/people.js）早就有了，但**控制台一个字都没有** ——
// 只能靠 `/自检` 看到一个总数（"人物 208"），既看不到是谁，也改不了。
//
// 这个接口只做三件事：列出、搜索、附带关系档位与笔记数量。
// 真正的写操作仍走 people-note（add/list/clear）与 person-forget（删人），
// 保持"列表只读、写操作显式"的分工。

export function createPeopleListHandler(baseDeps = {}) {
  const { log = () => {}, loadPeopleDb, levelOf, notesInScope, normalizeQQ } = baseDeps;

  /**
   * @param {{ q?: string, limit?: number, level?: string, scope?: string }} query
   */
  function build(query = {}) {
    const db = loadPeopleDb();
    const all = Object.values(db.people || {});
    const q = String(query.q ?? '').trim().toLowerCase();
    const scope = String(query.scope ?? 'global');
    const levelFilter = String(query.level ?? '').trim();
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 200));

    const entries = all.map((p) => {
      const qq = normalizeQQ(p.qq) || String(p.qq);
      const names = p.names || {};
      const byGroup = names.byGroup || {};
      const display = names.global || Object.values(byGroup).find(Boolean) || '';
      const relation = p.relation || {};
      const notes = p.notes || {};
      const noteCount = Object.values(notes).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
      return {
        qq,
        name: String(display || '').slice(0, 40),
        groupNames: Object.fromEntries(Object.entries(byGroup).slice(0, 12).map(([k, v]) => [k, String(v || '').slice(0, 40)])),
        level: levelOf(db, qq),
        msgCount: Number(relation.msgCount) || 0,
        activeDays: Array.isArray(relation.activeDays) ? relation.activeDays.length : 0,
        firstSeenAt: Number(relation.firstSeenAt) || 0,
        lastSeenAt: Number(relation.lastSeenAt) || 0,
        noteCount,
        notesInScope: scope && scope !== 'all' ? notesInScope(db, qq, scope) : undefined
      };
    });

    const filtered = entries.filter((e) => {
      if (levelFilter && e.level !== levelFilter) return false;
      if (!q) return true;
      if (e.qq.includes(q)) return true;
      if (e.name.toLowerCase().includes(q)) return true;
      return Object.values(e.groupNames).some((n) => String(n).toLowerCase().includes(q));
    });

    // 最近说话的排前面：人物库有 200+ 条时，按 QQ 号排序毫无意义
    filtered.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0) || b.msgCount - a.msgCount);

    return {
      ok: true,
      total: entries.length,
      matched: filtered.length,
      returned: Math.min(limit, filtered.length),
      truncated: filtered.length > limit,
      levelCounts: entries.reduce((m, e) => { m[e.level] = (m[e.level] || 0) + 1; return m; }, {}),
      scope,
      people: filtered.slice(0, limit)
    };
  }

  async function handle(ctx = {}) {
    const { url, sendJson } = ctx;
    try {
      const p = url?.searchParams;
      sendJson(build({
        q: p?.get('q') ?? '',
        limit: p?.get('limit') ?? '',
        level: p?.get('level') ?? '',
        scope: p?.get('scope') ?? 'global'
      }));
    } catch (error) {
      log(`人物库列表失败：${error?.message ?? error}`);
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  }

  return { handle, build };
}