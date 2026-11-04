// 网关体检（控制台按钮用，0.5.61）
//
// 把 `scripts/doctor-gateway.mjs` 的能力搬进 HTTP 接口，让用户在控制台点一下就能看到结论，
// 不用记命令、不用看 JSON。
//
//   GET  /api/gateway/doctor       诊断（只读）
//   POST /api/gateway/doctor/fix   按诊断结果改 config.json（先备份）
import fs from 'node:fs';
import path from 'node:path';
import { checkGatewayPreflight, probePort } from '../gateway-preflight.js';

const PORTS = {
  snowluma: { http: 3000, ws: 3001, webui: 5099, label: 'SnowLuma' },
  napcat: { http: 6198, ws: 6199, webui: 6099, label: 'NapCat' },
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/** 从 SnowLuma 自己的配置里读真实 token（同机部署时能直接对齐） */
function snowlumaTokens(homeDir) {
  const out = { httpToken: '', wsToken: '', uins: [] };
  if (!homeDir) return out;
  try {
    const dir = path.join(homeDir, 'config');
    for (const f of fs.readdirSync(dir)) {
      if (!/^onebot_\d+\.json$/.test(f)) continue;
      const d = readJson(path.join(dir, f));
      const nets = d?.networks || {};
      const http = (nets.httpServers || [])[0];
      const ws = (nets.wsServers || [])[0];
      if (http?.accessToken || ws?.accessToken) {
        out.uins.push(f.replace(/\D/g, ''));
        out.httpToken = http?.accessToken || out.httpToken;
        out.wsToken = ws?.accessToken || out.wsToken;
      }
    }
  } catch { /* 没有就算了 */ }
  return out;
}

async function loginInfo(provider, token) {
  const port = PORTS[provider]?.http;
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/get_login_info`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(4000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, ok: res.ok, userId: json?.data?.user_id || null, nickname: json?.data?.nickname || '', text: text.slice(0, 160) };
  } catch (error) {
    return { status: 0, ok: false, userId: null, nickname: '', text: String(error?.message ?? error).slice(0, 120) };
  }
}

export async function handleGatewayDoctorRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || !url.pathname.startsWith('/api/gateway/doctor')) return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const stateDir = d.stateDir || 'state';
  const cfgFile = path.join(path.dirname(stateDir), 'config.json');
  const raw = readJson(cfgFile) || {};
  const gw = raw.gateway || {};
  const legacy = raw.snowluma || {};
  const configured = String(gw.provider || 'snowluma').toLowerCase();
  const token = String(gw.token || legacy.accessToken || '');
  const httpToken = String(gw.httpToken || legacy.httpToken || token);

  // ── 端口实况 ──
  const ports = [];
  for (const [provider, p] of Object.entries(PORTS)) {
    for (const kind of ['http', 'ws', 'webui']) {
      ports.push({ provider, kind, port: p[kind], ok: await probePort(p[kind]) });
    }
  }
  const running = [...new Set(ports.filter((p) => p.ok && p.kind === 'ws').map((p) => p.provider))];

  const pre = await checkGatewayPreflight(raw);
  const slHome = legacy.homeDir || process.env.SNOWLUMA_HOME || '';
  const slTok = snowlumaTokens(slHome);
  const login = await loginInfo(configured, configured === 'snowluma' ? httpToken : token);

  const problems = [];
  const suggestions = [];
  if (!running.length) {
    problems.push('没有任何网关在监听（SnowLuma 3001 / NapCat 6199 都不通）—— 先启动网关');
  } else if (!running.includes(configured)) {
    problems.push(`配置写的是 ${PORTS[configured]?.label || configured}，但实际在跑的是 ${running.map((r) => PORTS[r]?.label || r).join(' / ')}`);
  }
  if (login && !login.ok) {
    problems.push(login.status === 401 ? '网关鉴权失败（401）：accessToken 与网关侧不一致' : `读登录信息失败：HTTP ${login.status || '无响应'}`);
  } else if (login?.ok && !login.userId) {
    problems.push('网关有响应但没有 QQ 号 —— QQ 可能未登录');
  }

  const target = running.includes('snowluma') ? 'snowluma' : running.includes('napcat') ? 'napcat' : '';
  if (target === 'snowluma') {
    suggestions.push('provider 改成 snowluma');
    suggestions.push('httpUrl 改成 http://127.0.0.1:3000');
    suggestions.push('wsUrl 改成 ws://127.0.0.1:3001');
    if (slTok.wsToken) suggestions.push('token / httpToken 用 SnowLuma 配置里的真实值（一键修复会自动填）');
  } else if (target === 'napcat') {
    suggestions.push('provider 改成 napcat');
    suggestions.push('httpUrl 改成 http://127.0.0.1:6198');
    suggestions.push('wsUrl 改成 ws://127.0.0.1:6199');
    suggestions.push('token 用 NapCat 里设置的值');
  }

  // ── 一键修复 ──
  if (url.pathname === '/api/gateway/doctor/fix' && req.method === 'POST') {
    if (!target) { sendJson({ ok: false, error: '没有检测到在运行的网关，先启动它再修' }, 400); return true; }
    try {
      const backup = `${cfgFile}.bak-doctor-${Date.now()}`;
      fs.copyFileSync(cfgFile, backup);
      const next = { ...raw };
      next.gateway = target === 'snowluma'
        ? { provider: 'snowluma', httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001', token: slTok.wsToken || token, httpToken: slTok.httpToken || httpToken }
        : { provider: 'napcat', httpUrl: 'http://127.0.0.1:6198', wsUrl: 'ws://127.0.0.1:6199', token };
      fs.writeFileSync(cfgFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      sendJson({ ok: true, fixed: next.gateway, backup: path.basename(backup), needRestart: true });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 200) }, 500);
    }
    return true;
  }

  if (url.pathname === '/api/gateway/doctor' && req.method === 'GET') {
    sendJson({
      ok: problems.length === 0,
      at: Date.now(),
      configured,
      configuredLabel: PORTS[configured]?.label || configured,
      running,
      ports,
      login,
      problems,
      suggestions,
      canAutoFix: Boolean(target),
      preflightHint: pre.hint,
    });
    return true;
  }

  sendJson({ ok: false, error: '未知的体检接口' }, 404);
  return true;
}
