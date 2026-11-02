// 数字中枢（0.5.52 · 控制台 B 方案）
//
// 一个页面装四件事：本地大脑 / 文件索引 / 长期记忆 / 密钥状态。
// 为什么单独一个模块：console-extra-routes 已经贴着行数棘轮（+50/次），
// 再往里塞就会逼着删注释；这里一次把中枢需要的接口收齐。
import fs from 'node:fs';
import path from 'node:path';
import { resolvePersona } from '../agent/persona.js';
import { atomicWriteJson } from '../atomic-write.js';
import { sharedRouterStatus, sharedRouterForce } from '../agent/brain-router.js';
import { findArchive, readArchive } from '../agent/archive.js';   // hub-route-archive


/** 写 config.json：走仓库统一的原子写（rename 只允许出现在 src/atomic-write.js） */
function writeConfig(file, obj) {
  atomicWriteJson(file, obj);
}

function readConfigFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

export async function handleHubRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || !url.pathname.startsWith('/api/hub/')) return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const readBody = typeof ctx.readBody === 'function' ? () => ctx.readBody() : async () => ({});
  let cfg = {};
  try { cfg = typeof d.getCfg === 'function' ? (d.getCfg() || {}) : {}; } catch { cfg = {}; }
  const stateDir = d.stateDir || 'state';
  const cfgFile = path.join(path.dirname(stateDir), 'config.json');

  // ── 总览：一个请求把四张卡要的数据都给了，避免首屏打四个接口 ──
  if (url.pathname === '/api/hub/overview' && req.method === 'GET') {
    const a = cfg.agent || {};
    const persona = resolvePersona(cfg, { cwd: process.cwd() });
    let keyEnc = false;
    let keyLen = 0;
    try {
      const onDisk = readConfigFile(cfgFile);
      keyEnc = Boolean(onDisk?.agent?.apiKeyEnc);
      keyLen = String(onDisk?.agent?.apiKeyEnc || '').length;
    } catch { /* 读不到就当没配 */ }
    sendJson({
      ok: true,
      at: Date.now(),
      agent: {
        mode: String(a.mode || 'dsh'),
        enabled: a.enabled !== false,
        model: String(a.model || ''),
        hasKey: Boolean(a.apiKey || a.apiKeyEnc),
        keyEnc,
        keyLen,
        personaSource: persona.source,
        maxSteps: Number(a.maxSteps) || 0,
        brain: sharedRouterStatus()?.brain || (a.mode === 'dsh' ? 'dsh' : 'local')
      },
      brainRouter: sharedRouterStatus(),
      fileIndex: {
        enabled: cfg.fileIndex?.enabled !== false,
        roots: cfg.fileIndex?.roots || []
      },
      stateDir
    });
    return true;
  }

  // ── 切换大脑：写 config，提示需要重启（运行中的会话不动，避免半路换脑） ──
  if (url.pathname === '/api/hub/agent-mode' && req.method === 'POST') {
    const body = await readBody();
    const mode = String(body?.mode || '');
    if (!['dsh', 'local'].includes(mode)) { sendJson({ ok: false, error: 'mode 只能是 dsh 或 local' }, 400); return true; }
    try {
      const onDisk = readConfigFile(cfgFile);
      onDisk.agent = { ...(onDisk.agent || {}), mode };
      writeConfig(cfgFile, onDisk);
      sendJson({ ok: true, mode, needRestart: true });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 200) }, 500);
    }
    return true;
  }

  // ── 手动切大脑（P4）：不写 config，只影响运行时；重启后按 auto 重新判定 ──
  if (url.pathname === '/api/hub/brain' && req.method === 'POST') {
    const body = await readBody();
    const brain = String(body?.brain || '');
    if (!['dsh', 'local'].includes(brain)) { sendJson({ ok: false, error: 'brain 只能是 dsh 或 local' }, 400); return true; }
    const st = sharedRouterForce(brain, 'manual(console)');
    if (!st) { sendJson({ ok: false, error: '路由还没初始化（先发一条消息，或等一次探测）' }, 409); return true; }
    sendJson({ ok: true, brain: st.brain, router: st });
    return true;
  }

  // ── 密钥状态：只回状态，**永不返回明文**（控制台是 HTTP 可访问的） ──
  if (url.pathname === '/api/hub/secret-status' && req.method === 'GET') {
    let onDisk = {};
    try { onDisk = readConfigFile(cfgFile)?.agent || {}; } catch { onDisk = {}; }
    const enc = String(onDisk.apiKeyEnc || '');
    const plain = String(onDisk.apiKey || '');
    let algo = 'none';
    if (enc.startsWith('dpapi:')) algo = 'dpapi';
    else if (enc.startsWith('local:')) algo = 'aes-256-gcm';
    else if (enc) algo = 'unknown';
    else if (plain) algo = 'plaintext';
    sendJson({
      ok: true,
      at: Date.now(),
      algo,
      encrypted: Boolean(enc),
      plaintext: Boolean(plain),
      length: enc.length || plain.length,
      canDecrypt: algo === 'dpapi' ? process.platform === 'win32' : algo === 'aes-256-gcm',
      hint: plain ? '明文：跑 node scripts/encrypt-agent-key.mjs --config <部署>/config.json' : ''
    });
    return true;
  }

  // ── 原文归档检索（0.5.58）：按字面线索找历史，再按 ref 读原文 ──
  if (url.pathname === '/api/hub/archive' && req.method === 'GET') {
    const r = findArchive({
      stateDir,
      q: String(url.searchParams.get('q') || ''),
      key: String(url.searchParams.get('key') || ''),
      limit: Number(url.searchParams.get('limit') || 8),
      offset: Number(url.searchParams.get('offset') || 0)
    });
    sendJson({ ok: true, at: Date.now(), ...r });
    return true;
  }
  if (url.pathname === '/api/hub/archive/read' && req.method === 'GET') {
    const r = readArchive({
      stateDir,
      ref: String(url.searchParams.get('ref') || ''),
      limit: Number(url.searchParams.get('limit') || 4000)
    });
    sendJson({ at: Date.now(), ...r });
    return true;
  }

  // ── 长期记忆：列表 / 追加 / 删除 ──
  if (url.pathname === '/api/hub/memory' && req.method === 'GET') {
    const key = String(url.searchParams.get('key') || '');
    if (!key) { sendJson({ ok: false, error: '需要 key' }, 400); return true; }
    const atoms = readAtoms(stateDir, key);
    sendJson({ ok: true, key, count: atoms.length, atoms: atoms.slice(-60).reverse() });
    return true;
  }
  if (url.pathname === '/api/hub/memory' && req.method === 'POST') {
    const body = await readBody();
    const key = String(body?.key || '');
    const text = String(body?.text || '').trim();
    if (!key || !text) { sendJson({ ok: false, error: 'key/text 不能为空' }, 400); return true; }
    try {
      const r = mutateAtoms(stateDir, key, (atoms) => {
        const dup = atoms.find((a) => String(a.text) === text);
        if (dup) return { duplicate: true };
        atoms.push({ text: text.slice(0, 500), weight: 2, createdAt: Date.now(), lastHitAt: Date.now(), hits: 0, tags: ['手动'] });
        return { added: true };
      });
      sendJson({ ok: true, ...r });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 200) }, 500);
    }
    return true;
  }
  if (url.pathname === '/api/hub/memory' && req.method === 'DELETE') {
    const body = await readBody();
    const key = String(body?.key || '');
    const text = String(body?.text || '');
    if (!key || !text) { sendJson({ ok: false, error: 'key/text 不能为空' }, 400); return true; }
    try {
      const r = mutateAtoms(stateDir, key, (atoms) => {
        const i = atoms.findIndex((a) => String(a.text) === text);
        if (i < 0) return { deleted: 0 };
        atoms.splice(i, 1);
        return { deleted: 1 };
      });
      sendJson({ ok: true, ...r });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 200) }, 500);
    }
    return true;
  }

  sendJson({ ok: false, error: '未知的中枢接口' }, 404);
  return true;
}

function readStateFile(stateDir) {
  const file = path.join(stateDir, 'social-v2.json');
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
}

function readAtoms(stateDir, key) {
  try {
    const { data } = readStateFile(stateDir);
    const st = data?.conversations?.[key];
    return Array.isArray(st?.longTermMemories) ? st.longTermMemories : [];
  } catch { return []; }
}

/** 读-改-写一次，保持其它字段不动 */
function mutateAtoms(stateDir, key, fn) {
  const { file, data } = readStateFile(stateDir);
  const conv = data.conversations || (data.conversations = {});
  const st = conv[key] || (conv[key] = {});
  if (!Array.isArray(st.longTermMemories)) st.longTermMemories = [];
  const before = st.longTermMemories.length;
  const result = fn(st.longTermMemories) || {};
  st.longTermMemories = st.longTermMemories.slice(-200);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { ...result, before, after: st.longTermMemories.length };
}
