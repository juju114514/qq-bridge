// state/ 的 schema 版本与迁移。
//
// 为什么要它：state 下全是 JSON（social-v2 / pending-queue / official-* / console-token…）。
// 字段改了之后，老用户的文件还是旧格式 —— 现在的防护只有"原子写 + 读坏就降级"，
// 表现是**静默丢数据**（话题没了、队列空了），而不是一次明确的升级动作。
//
// 约定：
//   · state/.schema.json 记录 { version, updatedAt }
//   · 迁移前把涉及的旧文件整份备份到 state/backups/schema-<from>-<ts>/
//   · 迁移是**幂等**的：跑两次结果一样；失败就保留备份并抛错，不半途改文件
//   · 版本比程序新（用户降级过）时只告警、不动文件 —— 宁可少动也不猜

import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 2;

/** 每个版本要做的事；键是"迁移到该版本"。 */
export const MIGRATIONS = {
  // v1：基线。只是把版本号写下来，不动任何文件。
  1: () => {},
  // v2：长期记忆层落地 —— 给已有会话补 longTermMemories: []（读代码时按"缺省空数组"兼容，
  //     但显式补上能让后续统计/迁移少一层判断）。
  2: ({ stateDir, log }) => {
    const file = path.join(stateDir, 'social-v2.json');
    if (!fs.existsSync(file)) return;
    // 文件损坏**不能阻断启动**：迁移阶段抛错会让 main() 直接退出，机器人整个起不来。
    // 处置：把坏文件改名隔离（保留证据），然后当作"没有这个文件"继续。
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      const quarantine = `${file}.corrupt-${Date.now()}`;
      // guard-allow: renameSync 损坏文件隔离（改名 .corrupt-<ts>，不是原子写）
      try { fs.renameSync(file, quarantine); } catch { /* 改名失败就算了，下面照样返回 */ }
      log?.(`⚠️ [schema] social-v2.json 解析失败，已隔离到 ${path.basename(quarantine)}（${error?.message ?? error}）`);
      return;
    }
    let changed = false;
    for (const conv of Object.values(raw?.conversations ?? {})) {
      if (conv && typeof conv === 'object' && !Array.isArray(conv.longTermMemories)) {
        conv.longTermMemories = [];
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  }
};

const SCHEMA_FILE = '.schema.json';

export function readSchemaVersion(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, SCHEMA_FILE), 'utf8').replace(/^\uFEFF/, ''));
    const v = Number(raw?.version);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0; // 文件不存在 = 老版本（或全新安装）
  }
}

export function writeSchemaVersion(stateDir, version = SCHEMA_VERSION) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, SCHEMA_FILE),
    JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

/** 把 state 下的 JSON 整份备份（迁移前的安全带）。 */
export function backupState(stateDir, fromVersion, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(stateDir, 'backups', `schema-${fromVersion}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  let count = 0;
  for (const name of fs.readdirSync(stateDir)) {
    const src = path.join(stateDir, name);
    if (!name.endsWith('.json') || name === SCHEMA_FILE) continue;
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(dir, name));
    count += 1;
  }
  return { dir, count };
}

/**
 * 启动时调用：把 state 迁移到当前版本。
 * @returns {{from:number,to:number,migrated:boolean,backup?:string,count?:number,warning?:string}}
 */
export function ensureStateSchema({ stateDir, log = () => {}, now = new Date(), current = SCHEMA_VERSION } = {}) {
  const from = readSchemaVersion(stateDir);
  if (from === current) return { from, to: current, migrated: false };

  if (from > current) {
    const warning = `state schema 版本 ${from} 比程序支持的 ${current} 新（是否降级过？）。`
      + '为免误改，本次不做迁移；请升级程序或从 backups/ 恢复。';
    log(`⚠️ ${warning}`);
    return { from, to: current, migrated: false, warning };
  }

  // 全新安装（from=0 且 state 为空）：直接记版本，不备份
  const hasData = fs.existsSync(stateDir) && fs.readdirSync(stateDir).some((n) => n.endsWith('.json'));
  if (!hasData) {
    writeSchemaVersion(stateDir, current);
    log(`[schema] 全新 state，已初始化为 v${current}`);
    return { from, to: current, migrated: true };
  }

  const { dir, count } = backupState(stateDir, from || 1, now);
  log(`[schema] 迁移 v${from || 1} → v${current}，已备份 ${count} 个文件到 ${path.relative(stateDir, dir)}`);

  for (let v = Math.max(1, from + 1); v <= current; v += 1) {
    const step = MIGRATIONS[v];
    if (!step) continue;
    try {
      step({ stateDir, log, from, to: v });
    } catch (error) {
      // 不写版本号：下次启动会重试；备份已在，数据可回滚
      log(`❌ [schema] 迁移到 v${v} 失败：${error?.message ?? error}（已备份，未写版本号）`);
      throw error;
    }
  }
  writeSchemaVersion(stateDir, current);
  log(`[schema] 迁移完成 → v${current}`);
  return { from: from || 1, to: current, migrated: true, backup: dir, count };
}
