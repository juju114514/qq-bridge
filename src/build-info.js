// 运行时指纹：让「现在跑的到底是哪套代码」可追溯。
//
// 由来（2026-10-31）：一天发 32 个版本、preset 有三份副本，
// 排查真机问题时无法从日志看出「加载的是哪份 preset、哪个 commit」。
// 这里把三件事固化下来：version / commit / presetHash。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeBuildId, readSourceCommit } from './build-id.js';

function tryReadCommit(root) {
  // 优先读 .git/HEAD（不打子进程，秒级）；失败返回空串。
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      const p = path.join(root, '.git', ref);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim().slice(0, 12);
      const packed = path.join(root, '.git', 'packed-refs');
      if (fs.existsSync(packed)) {
        for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
          const [sha, name] = line.trim().split(/\s+/);
          if (name === ref && sha) return sha.slice(0, 12);
        }
      }
      return '';
    }
    return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 12) : '';
  } catch { return ''; }
}

const PRESET_CANDIDATES = [
  ['dsh/agent-presets/qq-chat-v2/qq-tool-restrict.mjs', 'qq-chat-v2'],
  ['dsh/agent-presets/qq-chat/qq-tool-restrict.mjs', 'qq-chat'],
];

export function readBuildInfo(root, version = '') {
  const commit = tryReadCommit(root);
  const sourceCommit = readSourceCommit(root) || commit;
  const startedAt = Math.floor(Date.now() - (typeof process.uptime === 'function' ? process.uptime() * 1000 : 0));
  let buildId = '';
  try { buildId = computeBuildId(root).buildId; } catch { buildId = ''; }
  let ver = version;
  if (!ver) {
    try { ver = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? ''); } catch { ver = ''; }
  }
  for (const [rel, name] of PRESET_CANDIDATES) {
    const abs = path.join(root, rel);
    try {
      const buf = fs.readFileSync(abs);
      const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
      return { version: ver, commit: sourceCommit, sourceCommit, buildId, startedAt, preset: name, presetHash: sha, presetSource: rel };
    } catch { /* 换下一个候选 */ }
  }
  return { version: ver, commit: sourceCommit, sourceCommit, buildId, startedAt, preset: null, presetHash: '', presetSource: '' };
}

/** 一行指纹，用于启动横幅与 /health。 */
export function fingerprintLine(info) {
  const bits = [`version=${info.version || '?'}`];
  if (info.commit) bits.push(`commit=${info.commit}`);
  if (info.preset) bits.push(`preset=${info.preset}@${info.presetHash}`);
  return bits.join(' ');
}
