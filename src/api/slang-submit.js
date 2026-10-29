// 控制台/AI：提交黑话候选（POST /api/socialV2/slang/submit）。
//
// 去重与状态机是核心：已确认的重复提交直接回"已有"；被拒的不能再提交；
// 候选则累加次数并追加语境证据，达到阈值且开了 autoResearch 才触发联网研究。

export function createSlangSubmitHandler(baseDeps = {}) {
  const {
    log = () => {}, appendActivity = () => {},
    getCfg, agentTokenOk, v2SessionAllowed, v2ToolEnabled, allowSlangSubmit,
    redactKnownTokensOnly, slangEntries, SLANG_STATUS, createSlangEntry, publicSlangEntry,
    mergeEvidence, saveSlangStore, queueSlangTask, runSlangResearch
  } = baseDeps;

  async function handle(ctx = {}) {
    const { req, sendJson, readBody } = ctx;
    const cfg = getCfg();
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
    const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }

    const agentToken = req.headers['x-agent-token'];
    if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (agentToken && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return true; }
    if (cfg?.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return true; }
    if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return true; }
    if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return true; }
    if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return true; }

    const existing = slangEntries.find((e) => e.content === content);
    if (existing) {
      if (existing.status === SLANG_STATUS.CONFIRMED) {
        sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
        return true;
      }
      if (existing.status === SLANG_STATUS.REJECTED) {
        sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
        return true;
      }
      // candidate：累计出现次数并追加语境证据
      existing.count = (Number(existing.count) || 0) + 1;
      if (context) {
        existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
      }
      existing.updatedAt = new Date().toISOString();
      saveSlangStore();
      if (cfg?.slang?.autoResearch !== false) {
        const thresholds = Array.isArray(cfg?.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds : [];
        if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
          queueSlangTask(() => runSlangResearch([existing]));
        }
      }
      log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
      sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
      return true;
    }

    const entry = createSlangEntry({
      content,
      source: 'ai',
      status: SLANG_STATUS.CANDIDATE,
      evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
    });
    slangEntries.push(entry);
    saveSlangStore();
    if (cfg?.slang?.autoResearch !== false) queueSlangTask(() => runSlangResearch([entry]));
    log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
    appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
    sendJson({ ok: true, entry: publicSlangEntry(entry) });
    return true;
  }

  return { handle };
}