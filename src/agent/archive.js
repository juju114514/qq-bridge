// 原文归档 + 字面检索（0.5.57 · 借鉴 dsh-world 的思路）
//
// 为什么这样做（而不是只靠向量/原子记忆）：
//   一个人的生活，量没大到必须切片。把原文按天留着、需要时按原话去找，
//   比"切碎再拼回来"更准，也少一道会出错的环节。
//
// 与原子记忆分工：
//   · 原子记忆（longTermMemories）：每轮快速注入，负责"她大概记得什么"
//   · 原文归档：按需深挖，负责"那天你到底是怎么说的"
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FIND = 8;
const MAX_FIND = 40;
const SNIPPET = 200;
const DEFAULT_READ = 4000;
const MAX_READ = 16000;

const SAFE = /[^A-Za-z0-9_-]/g;   // Windows 上冒号是 ADS 语法，点号可能拼出 ..，都不要

/** 会话 key → 安全的文件名 */
export function archiveFileName(key) {
  const safe = String(key).replace(SAFE, '_').replace(/^_+|_+$/g, '');
  return `${safe || 'unknown'}.md`;
}

function dayOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function timeOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 追加一条原文。失败不抛（归档坏了不能影响聊天）。
 * @param {{stateDir:string, key:string, sender?:string, text:string, at?:number}} input
 */
export function appendArchive(input = {}) {
  const { stateDir = 'state', key = '', sender = '', text = '', at = Date.now() } = input;
  if (!key || !text) return { ok: false, error: 'key/text 为空' };
  try {
    const dir = path.join(stateDir, 'archive', dayOf(at));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, archiveFileName(key));
    const line = `- ${timeOf(at)} [${String(sender).slice(0, 20)}] ${String(text).replace(/\s+/g, ' ').slice(0, 2000)}\n`;
    fs.appendFileSync(file, line, 'utf8');
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 120) };
  }
}

function listFiles(stateDir) {
  const root = path.join(stateDir, 'archive');
  const out = [];
  try {
    for (const day of fs.readdirSync(root).sort().reverse()) {
      const dayDir = path.join(root, day);
      let names = [];
      try { names = fs.readdirSync(dayDir); } catch { continue; }
      for (const n of names) if (n.endsWith('.md')) out.push({ day, file: path.join(dayDir, n), name: n });
    }
  } catch { /* 还没有归档 */ }
  return out;
}

/**
 * 按字面线索找原文。
 * @param {{stateDir:string, q?:string, key?:string, limit?:number, offset?:number}} input
 * @returns {{ok:boolean, total:number, offset:number, hits:Array}}
 */
export function findArchive(input = {}) {
  const { stateDir = 'state', q = '', key = '', limit = DEFAULT_FIND, offset = 0 } = input;
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return { ok: true, total: 0, offset: 0, hits: [], note: 'q 为空' };
  const wantName = key ? archiveFileName(key) : '';
  const lim = Math.min(MAX_FIND, Math.max(1, Number(limit) || DEFAULT_FIND));
  const off = Math.max(0, Number(offset) || 0);

  const hits = [];
  for (const f of listFiles(stateDir)) {
    if (wantName && f.name !== wantName) continue;
    let lines = [];
    try { lines = fs.readFileSync(f.file, 'utf8').split('\n'); } catch { continue; }
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || !line.toLowerCase().includes(needle)) continue;
      hits.push({
        ref: `${f.day}/${f.name}:${i + 1}`,
        day: f.day,
        text: line.replace(/^\-\s*/, '').slice(0, SNIPPET)
      });
    }
  }
  return { ok: true, total: hits.length, offset: off, limit: lim, hits: hits.slice(off, off + lim) };
}

/**
 * 读某一天的原文（分页，避免一次把上下文吃光）。
 * @param {{stateDir:string, ref:string, offset?:number, limit?:number}} input
 */
export function readArchive(input = {}) {
  const { stateDir = 'state', ref = '', offset = 0, limit = DEFAULT_READ } = input;
  const m = /^(\d{4}-\d{2}-\d{2})\/([^:]+):(\d+)$/.exec(String(ref));
  if (!m) return { ok: false, error: 'ref 格式应为 YYYY-MM-DD/文件.md:行号' };
  const [, day, name, lineStr] = m;
  const file = path.join(stateDir, 'archive', day, name);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, error: '归档文件不存在' }; }
  const lines = text.split('\n');
  const start = Math.max(0, Number(lineStr) - 1);
  const lim = Math.min(MAX_READ, Math.max(1, Number(limit) || DEFAULT_READ));
  // 从命中行开始往前留一点上下文，再按字符上限截断
  const from = Math.max(0, start - 3);
  let out = '';
  for (let i = from; i < lines.length; i += 1) {
    const next = out + lines[i] + '\n';
    if (next.length > lim) break;
    out = next;
  }
  return { ok: true, ref, day, file: name, from: from + 1, text: out, truncated: out.length >= lim };
}

export const ARCHIVE_LIMITS = { DEFAULT_FIND, MAX_FIND, SNIPPET, DEFAULT_READ, MAX_READ };
