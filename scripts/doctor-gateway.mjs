#!/usr/bin/env node
// 网关体检 / 一键修复（0.5.60）
//
// 为什么需要它：真实事故（2026-11-04）——
//   配置里 `gateway.provider=napcat`，但机器上真正在跑的是 SnowLuma（3000/3001）。
//   桥接于是每秒重连一个根本不存在的端口，日志刷满 "WS 断开"，用户以为程序坏了。
//   同一次事故里还有第二个坑：SnowLuma 的 accessToken 与配置里的不一致 → 401。
//
// 这个脚本只做三件事：看清事实、说清原因、给出修法（--fix 才动文件）。
//
//   node scripts/doctor-gateway.mjs            只诊断
//   node scripts/doctor-gateway.mjs --fix      诊断 + 自动改 config.json（先备份）
//   node scripts/doctor-gateway.mjs --json     机器可读
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'config.json');
const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');

const PROBES = [
  { name: 'snowluma-http', host: '127.0.0.1', port: 3000, provider: 'snowluma' },
  { name: 'snowluma-ws', host: '127.0.0.1', port: 3001, provider: 'snowluma' },
  { name: 'snowluma-webui', host: '127.0.0.1', port: 5099, provider: 'snowluma' },
  { name: 'napcat-http', host: '127.0.0.1', port: 6198, provider: 'napcat' },
  { name: 'napcat-ws', host: '127.0.0.1', port: 6199, provider: 'napcat' },
  { name: 'napcat-webui', host: '127.0.0.1', port: 6099, provider: 'napcat' },
];

function readJsonSafe(file) {
  for (const enc of ['utf8', 'utf-8-sig']) {
    try { return JSON.parse(fs.readFileSync(file, enc).replace(/^\uFEFF/, '')); } catch { /* 下一个编码 */ }
  }
  return null;
}

function probeTcp({ host, port }, timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok, detail) => { if (done) return; done = true; try { s.destroy(); } catch { /* ignore */ } resolve({ ok, detail }); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true, ''));
    s.once('timeout', () => finish(false, '超时'));
    s.once('error', (e) => finish(false, e.code || '错误'));
    s.connect(port, host);
  });
}

async function httpJson(url, token, timeoutMs = 4000) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, ok: res.ok, json, text: text.slice(0, 200) };
  } catch (error) {
    return { status: 0, ok: false, json: null, text: String(error?.message ?? error).slice(0, 120) };
  }
}

/** 从 SnowLuma 自己的配置里读 token（同机部署时可直接对齐） */
function readSnowLumaTokens(snowlumaDir) {
  const out = { uins: [], httpToken: '', wsToken: '', webuiPort: 0 };
  try {
    const files = fs.readdirSync(path.join(snowlumaDir, 'config')).filter((f) => /^onebot_\d+\.json$/.test(f));
    for (const f of files) {
      const d = readJsonSafe(path.join(snowlumaDir, 'config', f));
      const nets = d?.networks || {};
      const http = (nets.httpServers || [])[0];
      const ws = (nets.wsServers || [])[0];
      if (http?.accessToken || ws?.accessToken) {
        out.uins.push(f.replace(/\D/g, ''));
        out.httpToken = http?.accessToken || out.httpToken;
        out.wsToken = ws?.accessToken || out.wsToken;
      }
    }
    const rt = readJsonSafe(path.join(snowlumaDir, 'config', 'runtime.json'));
    out.webuiPort = Number(rt?.webuiPort) || 0;
  } catch { /* 没有 SnowLuma 目录就算了 */ }
  return out;
}

async function main() {
  const raw = readJsonSafe(CFG) || {};
  const gw = raw.gateway || {};
  const legacy = raw.snowluma || {};
  const provider = String(gw.provider || 'snowluma').toLowerCase();
  const httpUrl = String(gw.httpUrl || legacy.httpUrl || '');
  const wsUrl = String(gw.wsUrl || legacy.wsUrl || '');
  const token = String(gw.token || legacy.accessToken || '');
  const httpToken = String(gw.httpToken || legacy.httpToken || token);

  const ports = [];
  for (const p of PROBES) ports.push({ ...p, ...(await probeTcp(p)) });

  const listening = ports.filter((p) => p.ok);
  const runningProviders = [...new Set(listening.map((p) => p.provider))];

  // 用配置里的 token 试一次登录信息（snowluma 用 httpToken，napcat 用 token）
  let login = null;
  const probeHttp = listening.find((p) => p.name.endsWith('-http'));
  if (probeHttp) {
    login = await httpJson(`http://127.0.0.1:${probeHttp.port}/get_login_info`, probeHttp.provider === 'snowluma' ? httpToken : token);
  }

  const snowlumaDir = legacy.homeDir || process.env.SNOWLUMA_HOME || '';
  const slTokens = readSnowLumaTokens(snowlumaDir);

  const problems = [];
  if (!listening.length) {
    problems.push('没有任何网关端口在监听（3000/3001/6198/6199 全不通）——先确认 SnowLuma 或 NapCat 已启动');
  } else if (!runningProviders.includes(provider)) {
    problems.push(`配置指向 ${provider}，但实际在跑的是 ${runningProviders.join('/')}（端口对不上，桥接会无限重连）`);
  }
  if (login && !login.ok) {
    if (login.status === 401) problems.push('网关鉴权失败（401）：accessToken 与网关侧不一致');
    else problems.push(`get_login_info 异常：HTTP ${login.status || '无响应'} ${login.text || ''}`);
  }
  if (login?.ok && login.json?.data?.user_id) {
    // 登录正常，没有额外问题
  } else if (login?.ok) {
    problems.push('get_login_info 返回 200 但没有 user_id —— QQ 可能未登录');
  }

  const suggestion = [];
  const target = runningProviders.includes('snowluma') ? 'snowluma' : runningProviders.includes('napcat') ? 'napcat' : '';
  if (target) {
    if (target === 'snowluma') {
      suggestion.push(`gateway.provider = "snowluma"`);
      suggestion.push(`gateway.httpUrl  = "http://127.0.0.1:3000"`);
      suggestion.push(`gateway.wsUrl    = "ws://127.0.0.1:3001"`);
      if (slTokens.wsToken) suggestion.push(`gateway.token     = "${slTokens.wsToken}"      // 来自 SnowLuma wsServers[0]`);
      if (slTokens.httpToken) suggestion.push(`gateway.httpToken = "${slTokens.httpToken}"  // 来自 SnowLuma httpServers[0]`);
    } else {
      suggestion.push(`gateway.provider = "napcat"`);
      suggestion.push(`gateway.httpUrl  = "http://127.0.0.1:6198"`);
      suggestion.push(`gateway.wsUrl    = "ws://127.0.0.1:6199"`);
      suggestion.push(`gateway.token     = "<NapCat 里设置的 token>"`);
    }
  }

  // --fix：只改能确定的字段，改前备份
  let fixed = null;
  if (FIX && target && problems.length) {
    const backup = `${CFG}.bak-doctor-${Date.now()}`;
    fs.copyFileSync(CFG, backup);
    const next = { ...raw };
    next.gateway = target === 'snowluma'
      ? { provider: 'snowluma', httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001', token: slTokens.wsToken || token, httpToken: slTokens.httpToken || httpToken }
      : { provider: 'napcat', httpUrl: 'http://127.0.0.1:6198', wsUrl: 'ws://127.0.0.1:6199', token };
    fs.writeFileSync(CFG, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fixed = { backup, gateway: next.gateway };
  }

  const result = {
    ok: problems.length === 0,
    config: { provider, httpUrl, wsUrl, tokenLen: token.length, httpTokenLen: httpToken.length },
    ports: ports.map(({ name, port, provider: pv, ok, detail }) => ({ name, port, provider: pv, ok, detail })),
    runningProviders,
    login: login ? { status: login.status, ok: login.ok, userId: login.json?.data?.user_id || null, nickname: login.json?.data?.nickname || '' } : null,
    snowlumaTokensFound: Boolean(slTokens.httpToken || slTokens.wsToken),
    problems,
    suggestion,
    fixed,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  const line = (s = '') => console.log(s);
  line('');
  line('  网关体检');
  line('  ─────────────────────────────────────────────');
  line(`  配置：provider=${provider}  http=${httpUrl || '(空)'}  ws=${wsUrl || '(空)'}  token=${token.length} 位`);
  line('');
  line('  端口：');
  for (const p of ports) line(`    ${p.ok ? '✓' : '✗'} ${String(p.port).padEnd(5)} ${p.name.padEnd(16)} ${p.ok ? 'LISTEN' : p.detail}`);
  line('');
  if (login) {
    line(`  登录信息：HTTP ${login.status}${login.ok ? `  QQ ${login.json?.data?.user_id || '?'} (${login.json?.data?.nickname || '?'})` : `  ${login.text || ''}`}`);
    line('');
  }
  if (!problems.length) {
    line('  ✓ 没问题：配置与实际运行的网关一致');
  } else {
    line('  发现的问题：');
    for (const p of problems) line(`    · ${p}`);
    if (suggestion.length) {
      line('');
      line('  建议改成：');
      for (const s of suggestion) line(`    ${s}`);
    }
  }
  if (fixed) {
    line('');
    line(`  ✓ 已修复并写回 config.json（备份：${path.basename(fixed.backup)}）`);
    line('    请重启桥接后生效。');
  } else if (!result.ok && !FIX) {
    line('');
    line('  想自动修：node scripts/doctor-gateway.mjs --fix');
  }
  line('');
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('  体检脚本自身出错：', error?.message ?? error);
  process.exit(2);
});
