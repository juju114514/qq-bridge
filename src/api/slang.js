/**
 * 黑话系统：/api/slang, /api/slang/clear|batch-*|extract|research|config, /api/slang/:id(/confirm|/reject)
 *
 * 「按域拆 handler」第 4 组（slang，14 条路由命中）。行为与迁移前逐行等价。
 *
 * 状态说明：`slangEntries` 在 bridge 里是 `let`（会被整体替换），所以这里用
 * getEntries()/setEntries() 而不是直接持有数组；几个 Map（窗口/冷却/提交时间/研究中）
 * 只做原地 clear，直接用引用即可。
 */

export function createSlangHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    path,
    ROOT,
    readConfigObject,
    atomicWriteJson,
    getCfg,
    setSlangConfig,
    getEntries,
    setEntries,
    isWritable,
    saveStore,
    createSlangEntry,
    SLANG_STATUS,
    slangWindows,
    slangExtractionCooldowns,
    slangSubmitTimes,
    slangResearchingIds,
    queueSlangTask,
    runSlangExtraction,
    runSlangResearch,
    invalidateSlangLearnerSession,
    saveSlangConfig,
  } = deps;

  const VALID_STATUS = [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED];
  const findIndexById = (entries, id) => entries.findIndex((e) => e.id === id);

  return async function handleSlang(req, url) {
    const { pathname } = url;
    const method = req.method;

    // ── GET /api/slang ─────────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/slang') {
      const status = url.searchParams.get('status') || '';
      const entries = getEntries();
      const list = status ? entries.filter((e) => e.status === status) : entries;
      sendJson({ entries: list, config: getCfg().slang, writable: isWritable() });
      return true;
    }

    // ── POST /api/slang —— 手工新增 ─────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/slang') {
      const body = await readBody();
      const content = String(body.content ?? '').trim();
      if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return true; }
      const entries = getEntries();
      if (entries.some((e) => e.content === content)) {
        sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400);
        return true;
      }
      const entry = createSlangEntry({
        content,
        meaning: String(body.meaning ?? '').trim(),
        usage: String(body.usage ?? '').trim(),
        example: String(body.example ?? '').trim(),
        risk: String(body.risk ?? '').trim(),
        sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
        status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
        source: 'manual',
        evidence: Array.isArray(body.evidence) ? body.evidence : [],
      });
      entries.push(entry);
      setEntries(entries);
      saveStore();
      log(`控制台：新增黑话「${content}」`);
      sendJson({ ok: true, entry });
      return true;
    }

    // ── POST /api/slang/clear ──────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/slang/clear') {
      const body = await readBody();
      const status = String(body.status ?? '').trim();
      if (status && !VALID_STATUS.includes(status)) {
        sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
        return true;
      }
      let entries = getEntries();
      let removedCount = 0;
      if (status) {
        removedCount = entries.filter((e) => e.status === status).length;
        entries = entries.filter((e) => e.status !== status);
        setEntries(entries);
      } else {
        removedCount = entries.length;
        setEntries([]);
        // 清空所有时同步清掉待提取窗口和冷却，避免「删了又回来」
        slangWindows.clear();
        slangExtractionCooldowns.clear();
        slangSubmitTimes.clear();
        slangResearchingIds.clear();
      }
      saveStore();
      log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
      sendJson({ ok: true, removedCount });
      return true;
    }

    // ── POST /api/slang/batch-delete ───────────────────────────────────────
    if (method === 'POST' && pathname === '/api/slang/batch-delete') {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      const status = String(body.status ?? '').trim();
      let entries = getEntries();
      if (ids.length) {
        const idSet = new Set(ids);
        const before = entries.length;
        entries = entries.filter((e) => !idSet.has(e.id));
        setEntries(entries);
        const removedCount = before - entries.length;
        if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return true; }
        saveStore();
        log(`控制台：批量删除黑话 ${removedCount} 条`);
        sendJson({ ok: true, removedCount });
        return true;
      }
      if (status && !VALID_STATUS.includes(status)) {
        sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
        return true;
      }
      if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return true; }
      const removedCount = entries.filter((e) => e.status === status).length;
      entries = entries.filter((e) => e.status !== status);
      setEntries(entries);
      saveStore();
      log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
      sendJson({ ok: true, removedCount });
      return true;
    }

    // ── POST /api/slang/batch-confirm ──────────────────────────────────────
    if (method === 'POST' && pathname === '/api/slang/batch-confirm') {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return true; }
      const entries = getEntries();
      let confirmedCount = 0;
      let skippedCount = 0;
      const skipped = [];
      for (const id of ids) {
        const idx = findIndexById(entries, id);
        if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
        const entry = entries[idx];
        if (entry.status !== SLANG_STATUS.CANDIDATE) {
          skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue;
        }
        if (!entry.meaning || !String(entry.meaning).trim()) {
          skippedCount++; skipped.push({ id, content: entry.content, reason: '缺含义' }); continue;
        }
        entry.status = SLANG_STATUS.CONFIRMED;
        entry.updatedAt = new Date().toISOString();
        confirmedCount++;
      }
      if (confirmedCount) saveStore();
      log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
      sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
      return true;
    }

    // ── POST /api/slang/batch-reject ───────────────────────────────────────
    if (method === 'POST' && pathname === '/api/slang/batch-reject') {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return true; }
      const entries = getEntries();
      let rejectedCount = 0;
      for (const id of ids) {
        const idx = findIndexById(entries, id);
        if (idx < 0) continue;
        const entry = entries[idx];
        if (entry.status === SLANG_STATUS.REJECTED) continue;
        entry.status = SLANG_STATUS.REJECTED;
        entry.updatedAt = new Date().toISOString();
        rejectedCount++;
      }
      if (rejectedCount) saveStore();
      log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
      sendJson({ ok: true, rejectedCount });
      return true;
    }

    // ── POST /api/slang/extract —— 触发一次提取 ────────────────────────────
    if (method === 'POST' && pathname === '/api/slang/extract') {
      if (getCfg().slang?.enabled === false) {
        sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400);
        return true;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (key && slangWindows.has(key)) {
        queueSlangTask(() => runSlangExtraction(key));
        sendJson({ ok: true, key });
      } else {
        const firstKey = slangWindows.keys().next().value;
        if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return true; }
        queueSlangTask(() => runSlangExtraction(firstKey));
        sendJson({ ok: true, key: firstKey });
      }
      return true;
    }

    // ── POST /api/slang/research —— 研究候选 ───────────────────────────────
    if (method === 'POST' && pathname === '/api/slang/research') {
      if (getCfg().slang?.enabled === false) {
        sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400);
        return true;
      }
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const entries = getEntries();
      const candidates = ids.length
        ? entries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
        : entries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
      if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return true; }
      queueSlangTask(() => runSlangResearch(candidates));
      sendJson({ ok: true, count: candidates.length });
      return true;
    }

    // ── POST /api/slang/config —— 黑话系统配置 ─────────────────────────────
    if (method === 'POST' && pathname === '/api/slang/config') {
      const body = await readBody();
      const before = getCfg().slang ?? {};
      const oldPreset = before.learnerPreset;
      const oldWorkspaceTitle = before.workspaceTitle;
      const merged = { ...before, ...body };
      if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
      else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
      if (merged.extractMinMessages !== undefined) {
        merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
      }
      if (merged.extractCooldownMs !== undefined) {
        merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
      }
      if (merged.injectMax !== undefined) {
        merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
      }
      if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
      if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
      if (merged.workspaceTitle !== undefined) {
        merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
      }
      if (body.inferenceThresholds !== undefined) {
        const raw = Array.isArray(body.inferenceThresholds)
          ? body.inferenceThresholds
          : String(body.inferenceThresholds).split(/[,，\s]+/);
        merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
        if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
      }
      saveSlangConfig(merged);
      if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
        invalidateSlangLearnerSession();
        log('黑话学习 preset 已变更，已重置学习会话');
      } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
        invalidateSlangLearnerSession();
        log('黑话学习工作区名已变更，已重置学习会话');
      }
      log('控制台：黑话系统配置已更新');
      sendJson({ ok: true, config: getCfg().slang });
      return true;
    }

    // ── /api/slang/:id 与 /api/slang/:id/(confirm|reject) ──────────────────
    const m = pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
    if (!m) {
      // 其余 /api/slang/* 不在这里处理（交给后续分支/兜底 404）
      return false;
    }
    const id = m[1];

    if (method === 'PATCH' && !m[2]) {
      const entries = getEntries();
      const idx = findIndexById(entries, id);
      if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
      const body = await readBody();
      const entry = { ...entries[idx] };
      if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
      if (body.content !== undefined && entries.some((e) => e.id !== id && e.content === entry.content)) {
        sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
        return true;
      }
      if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
      if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
      if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
      if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
      if (body.sources !== undefined) {
        entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [];
      }
      if (body.status !== undefined && VALID_STATUS.includes(body.status)) entry.status = body.status;
      if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return true; }
      entry.updatedAt = new Date().toISOString();
      entries[idx] = entry;
      saveStore();
      log(`控制台：更新黑话「${entry.content}」`);
      sendJson({ ok: true, entry });
      return true;
    }

    if (method === 'POST' && m[2] === 'confirm') {
      const entries = getEntries();
      const idx = findIndexById(entries, id);
      if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
      const body = await readBody();
      const entry = entries[idx];
      if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
      if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
      if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
      if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
      if (body.sources !== undefined) {
        entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [];
      }
      if (!entry.meaning) {
        sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
        return true;
      }
      entry.status = SLANG_STATUS.CONFIRMED;
      entry.updatedAt = new Date().toISOString();
      saveStore();
      log(`控制台：确认黑话「${entry.content}」`);
      sendJson({ ok: true, entry });
      return true;
    }

    if (method === 'POST' && m[2] === 'reject') {
      const entries = getEntries();
      const idx = findIndexById(entries, id);
      if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
      const entry = entries[idx];
      entry.status = SLANG_STATUS.REJECTED;
      entry.updatedAt = new Date().toISOString();
      saveStore();
      log(`控制台：拒绝黑话「${entry.content}」`);
      sendJson({ ok: true, entry });
      return true;
    }

    if (method === 'DELETE' && !m[2]) {
      const entries = getEntries();
      const idx = findIndexById(entries, id);
      if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
      const [removed] = entries.splice(idx, 1);
      saveStore();
      log(`控制台：删除黑话「${removed.content}」`);
      sendJson({ ok: true, removed });
      return true;
    }

    return false;
  };
}

export default createSlangHandler;
