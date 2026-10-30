// 控制台：仿真预设提示词的读/写/备份/还原（/api/preset/sim-prompt*）。
//
// 为什么单独一块：这四条路由是"同一个资源"的四个动作，逻辑长但边界清楚；
// 且**安全语义很重**（保存要过不变量校验、还原要拒绝路径穿越 + 拒绝弱化版备份）。
// 放在 bridge 的巨型 if 链里，改动风险远高于独立模块。
//
// 依赖：baseDeps 启动给一次；ctx 每请求（sendJson / readBody / url）。

export function createPresetSimHandlers(baseDeps = {}) {
  const {
    log = () => {}, fs, path,
    knownPresetName, PRESET_NAMES, PRESET_BACKUP_DIR,
    readPresetPromptText, renderPresetPromptYaml, presetStatus, presetPromptWarnings, presetPromptBlockers,
    extractPresetPrefix, backupPresetFile, listPresetBackups,
    atomicWriteText, presetSourceYaml, installedPresetYaml
  } = baseDeps;

  const presetListText = () => Object.values(PRESET_NAMES).join(' / ');

  async function handleGetPrompt(ctx = {}) {
    const { url, sendJson } = ctx;
    const preset = knownPresetName(url.searchParams.get('preset'));
    if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${presetListText()}）` }, 400); return true; }
    try {
      const { prefix } = readPresetPromptText(preset);
      sendJson({
        ok: true,
        content: prefix,
        chars: prefix.length,
        bytes: Buffer.byteLength(prefix, 'utf8'),
        warnings: presetPromptWarnings(prefix),
        status: presetStatus(preset),
        presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n))
      });
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
    }
    return true;
  }

  async function handleSavePrompt(ctx = {}) {
    const { readBody, sendJson } = ctx;
    const body = await readBody();
    const preset = knownPresetName(body.preset);
    if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${presetListText()}）` }, 400); return true; }
    let nextText;
    try {
      const { text, prefix } = readPresetPromptText(preset);
      // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
      // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
      const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
      if (normalized === prefix) {
        sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix) });
        return true;
      }
      nextText = renderPresetPromptYaml(text, body.content, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
      return true;
    }
    const warnings = presetPromptWarnings(body.content);
    let sourceBackup = null;
    try {
      sourceBackup = backupPresetFile(preset);
      atomicWriteText(presetSourceYaml(preset), nextText);
      // 同步到 DSH 实际读取的安装目录。
      // 安装副本不做仓库内备份——它和源文件一致，备份它等于把含本机绝对路径的快照塞进仓库。
      const installed = installedPresetYaml(preset);
      if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
    } catch (error) {
      // 尽力回滚源文件，避免留下半截状态
      if (sourceBackup && fs.existsSync(sourceBackup)) {
        try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch { /* 忽略 */ }
      }
      sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
      return true;
    }
    log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条提醒` : ''}`);
    sendJson({
      ok: true,
      chars: String(body.content ?? '').length,
      warnings,
      synced: fs.existsSync(installedPresetYaml(preset)),
      requiresRestart: true,
      status: presetStatus(preset)
    });
    return true;
  }

  async function handleListBackups(ctx = {}) {
    const { url, sendJson } = ctx;
    const preset = knownPresetName(url.searchParams.get('preset'));
    if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${presetListText()}）` }, 400); return true; }
    try { sendJson({ ok: true, backups: listPresetBackups(preset) }); }
    catch (error) { sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500); }
    return true;
  }

  async function handleRestore(ctx = {}) {
    const { readBody, sendJson } = ctx;
    const body = await readBody();
    const preset = knownPresetName(body.preset);
    if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${presetListText()}）` }, 400); return true; }
    try {
      const requested = String(body.file ?? '').trim();
      const candidates = listPresetBackups(preset).map((b) => b.file);
      const target = requested || candidates[0];
      // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
      if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return true; }
      const backupPath = path.join(PRESET_BACKUP_DIR, target);
      const restored = fs.readFileSync(backupPath, 'utf8');
      const restoredPrefix = extractPresetPrefix(restored);
      if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return true; }
      // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
      // 直接还原会把弱化版提示词写回去。不变量清单按预设取（一代没有工具面表述）。
      const blockers = presetPromptBlockers(restoredPrefix, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
      if (blockers.length) {
        sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
        return true;
      }
      backupPresetFile(preset);
      atomicWriteText(presetSourceYaml(preset), restored);
      const installed = installedPresetYaml(preset);
      if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
      log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
      sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
    }
    return true;
  }

  return { handleGetPrompt, handleSavePrompt, handleListBackups, handleRestore };
}

/**
 * 派发链入口：/api/preset/sim-prompt*
 *    GET  /api/preset/sim-prompt          读提示词
 *    POST /api/preset/sim-prompt          保存
 *    GET  /api/preset/sim-prompt/backups  备份列表
 *    POST /api/preset/sim-prompt/restore  从备份恢复
 * 返回 true = 认领了请求；false = 不是我的（交给链上下一个）。
 */
export async function handlePresetSimRoutes(req, url, { presetSim, sendJson, readBody } = {}) {
  const p = url.pathname;
  if (p !== '/api/preset/sim-prompt' && !p.startsWith('/api/preset/sim-prompt/')) return false;
  if (req.method === 'GET' && p === '/api/preset/sim-prompt') { await presetSim.handleGetPrompt({ url, sendJson }); return true; }
  if (req.method === 'POST' && p === '/api/preset/sim-prompt') { await presetSim.handleSavePrompt({ readBody, sendJson }); return true; }
  if (req.method === 'GET' && p === '/api/preset/sim-prompt/backups') { await presetSim.handleListBackups({ url, sendJson }); return true; }
  if (req.method === 'POST' && p === '/api/preset/sim-prompt/restore') { await presetSim.handleRestore({ readBody, sendJson }); return true; }
  return false;
}
