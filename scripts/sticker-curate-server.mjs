#!/usr/bin/env node
// 表情策展独立服务（C 方案）：**完全不碰 bridge.js**。
//
// 为什么单独跑：
//   bridge.js 已经 1600+ 行，且任何改动都可能让个人号通道掉线；
//   策展是个可选的增值功能，用独立进程隔离风险 —— 它挂了，机器人照常聊天。
//
// 用法：
//   node scripts/sticker-curate-server.mjs            # 默认 127.0.0.1:3181
//   PORT=3182 node scripts/sticker-curate-server.mjs
//
// 鉴权：Bearer token，首次启动生成到 state/sticker-curate-token
// 安全默认：config.socialV2.sticker.curator.enabled 为 false 时，写操作一律 403

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3181);
const HOST = '127.0.0.1';

const curator = await import(pathToFileURL(path.join(ROOT, 'src', 'sticker-curator.js')).href);
const notes = await import(pathToFileURL(path.join(ROOT, 'src', 'sticker-notes.js')).href);

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch { return {}; }
}

function tokenPath() { return path.join(ROOT, 'state', 'sticker-curate-token'); }
function notesPath() { return path.join(ROOT, 'state', 'sticker-notes.json'); }

function loadToken() {
  try {
    const t = fs.readFileSync(tokenPath(), 'utf8').trim();
    if (t) return t;
  } catch { /* ignore */ }
  const t = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
    fs.writeFileSync(tokenPath(), t, 'utf8');
    console.log('[curate] 已生成令牌：state/sticker-curate-token');
  } catch (e) {
    console.error('[curate] 无法写入令牌文件：', e?.message ?? e);
  }
  return t;
}

const TOKEN = loadToken();

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function authOk(req) {
  const h = String(req.headers.authorization || '');
  const got = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!got || got.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i += 1) diff |= got.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    const cfg = readConfig();
    const c = { ...curator.DEFAULT_CURATOR, ...(cfg.socialV2?.sticker?.curator || {}) };
    return json(res, { ok: true, service: 'sticker-curate', port: PORT, enabled: c.enabled === true });
  }

  if (url.pathname !== '/curate') return json(res, { ok: false, error: 'not found' }, 404);
  if (req.method !== 'POST') return json(res, { ok: false, error: '只支持 POST' }, 405);
  if (!authOk(req)) return json(res, { ok: false, error: '缺少或错误的 Bearer 令牌' }, 401);

  const cfg = readConfig();
  const opts = cfg.socialV2?.sticker?.curator || {};
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: String(e?.message ?? e) }, 400); }

  const meaning = curator.normalizeMeaning(body.meaning);
  if (!meaning) return json(res, { ok: false, error: 'meaning 不能为空（说不出含义就不收藏）' }, 400);

  const apply = body.apply === true;
  if (apply && opts.enabled !== true) {
    return json(res, { ok: false, error: '表情策展未启用（config.socialV2.sticker.curator.enabled=false）' }, 403);
  }

  const tags = Array.isArray(body.tags) ? body.tags.slice(0, 6) : [];
  const score = curator.scoreSticker({
    meaning, tags, duplicate: body.duplicate === true,
    animated: body.animated === true, eyesOnly: body.eyesOnly === true
  });
  const collect = curator.decideCollect({ score, collectedToday: Number(body.collectedToday ?? 0) || 0 }, opts);
  const send = curator.decideProactiveSend({
    relevance: Number(body.relevance ?? 0) || 0,
    lastSentAt: Number(body.lastSentAt ?? 0) || 0,
    sentThisHour: Number(body.sentThisHour ?? 0) || 0,
    mood: String(body.mood ?? '')
  }, opts);

  // 落一条笔记（像 QQ 黑话那样单独存），不碰 prompt、不碰 bridge
  let noteId = String(body.id ?? '').trim();
  if (!noteId) noteId = 'auto-' + crypto.createHash('sha1').update(meaning).digest('hex').slice(0, 10);
  let store = notes.loadStickerNotes(notesPath());
  notes.upsertStickerNote(store, {
    id: noteId, meaning, tags, score, scope: body.scope,
    status: notes.STICKER_NOTE_STATUS.PENDING, source: 'curate'
  });
  if (apply && send.send) notes.markStickerUsed(store, noteId);
  try { notes.saveStickerNotes(notesPath(), store); } catch (e) { console.error('[curate] 笔记落盘失败:', e?.message ?? e); }

  // 本服务只做决策，不代替桥接执行收藏/发送（避免两处都能往群里发东西）
  json(res, {
    ok: true, applied: false, meaning, score, collect, send, noteId,
    scope: notes.normalizeScope(body.scope),
    hint: '决策结果交回桥接执行；本服务不直接调用 OneBot，避免双通道刷屏'
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[curate] 表情策展服务已启动：http://${HOST}:${PORT}（GET /health, POST /curate）`);
  console.log('[curate] 令牌：state/sticker-curate-token');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
