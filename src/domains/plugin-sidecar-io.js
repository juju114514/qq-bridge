// sidecar 的落盘部分（N2）：群记忆文件、事件日志、意图应用。
//
// 全部走注入（fs/path/stateDir），因为 bridge 只在运行时才知道 ROOT —— 而且这样能离线测。
// 设计约束：
//   · 群记忆：state/memory/<key>.md，交接段由 src/domains/memory-handoff.js 管
//   · 事件：state/plugin-events.jsonl（追加，单行 JSON，便于回放/排查）
//   · 意图：只做"打开就安全"的几种；未知意图返回 applied:0 而不是抛错

import { renderHandoff, upsertHandoff, extractHandoff, checkHandoff } from './memory-handoff.js';

/** key（group:123 / private:456）→ 安全文件名 */
export function memoryFileName(key) {
  // 注意：**不能保留冒号** —— Windows 上 `group:123.md` 会被解释成 NTFS 备用数据流，
  // 实际写进名为 `group` 的文件，读的时候"看起来成功"，但文件列表里找不到。
  return String(key ?? '').replace(/[^a-zA-Z0-9_-]/g, '_') + '.md';
}

export function createSidecarIo({ fs, path, stateDir, log = () => {} } = {}) {
  const memoryDir = path.join(stateDir, 'memory');
  const eventFile = path.join(stateDir, 'plugin-events.jsonl');

  function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  }

  function readMemory(key) {
    const file = path.join(memoryDir, memoryFileName(key));
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  }

  function writeMemory(key, text) {
    ensureDir(memoryDir);
    const file = path.join(memoryDir, memoryFileName(key));
    fs.writeFileSync(file, String(text ?? ''), 'utf8');
    return file;
  }

  function appendEvent(event) {
    ensureDir(stateDir);
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
    fs.appendFileSync(eventFile, line, 'utf8');
  }

  /** 应用一个意图；返回 { applied, note }。 */
  async function applyIntent({ key, intent, payload = {} }, hooks = {}) {
    if (intent === 'memory.handoff') {
      const block = renderHandoff({
        lastTalkedAbout: payload.lastTalkedAbout,
        currentTopics: payload.currentTopics,
        memoryChanges: payload.memoryChanges,
        nextStep: payload.nextStep,
      });
      const next = upsertHandoff(readMemory(key), block);
      writeMemory(key, next);
      return { applied: 1, note: 'handoff 已写入', check: checkHandoff(next) };
    }
    if (intent === 'memory.append') {
      const line = String(payload.text ?? '').trim();
      if (!line) return { applied: 0, note: 'text 为空' };
      const cur = readMemory(key);
      writeMemory(key, (cur ? cur.replace(/\s*$/, '') + '\n\n' : '') + line + '\n');
      return { applied: 1, note: '已追加' };
    }
    if (intent === 'read.mark') {
      if (typeof hooks.markRead === 'function') {
        await hooks.markRead({ key, throughSeq: Number(payload.throughSeq ?? 0) || 0 });
        return { applied: 1, note: '已读水位已更新' };
      }
      return { applied: 0, note: '本进程没有 markRead 钩子' };
    }
    if (intent === 'activity') {
      if (typeof hooks.appendActivity === 'function') {
        hooks.appendActivity(`[plugin] ${key} ${String(payload.text ?? '')}`.slice(0, 200));
        return { applied: 1, note: '已记活动' };
      }
      return { applied: 0, note: '没有活动日志' };
    }
    log('未知意图：' + intent);
    return { applied: 0, note: '未知意图 ' + intent };
  }

  return { readMemory, writeMemory, appendEvent, applyIntent, extractHandoff, memoryDir, eventFile };
}