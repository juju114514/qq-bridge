#!/usr/bin/env node
// 网关能力探测：同一个桥接，SnowLuma 和 NapCat 能做的事**不一样**。
//
// 为什么需要它：
//   实测 NapCat 对收藏表情是**只读**的（fetch_custom_face_detail 可用，
//   add_custom_face / modify_custom_face 都不可用），而桥接的收藏功能是按
//   SnowLuma 的 API 写的。换网关后"功能突然不работ"往往就是这个原因。
//
// 用法：
//   node scripts/probe-gateway-caps.mjs                       # 默认 127.0.0.1:3000
//   node scripts/probe-gateway-caps.mjs --port 3000 --token xxx
//   node scripts/probe-gateway-caps.mjs --json                # 只输出 JSON
//
// 令牌来源（按优先级）：--token → 环境变量 ONEBOT_TOKEN →
//   <repo>/config.json 的 snowluma.accessToken

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const getArg = (name, def = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const PORT = Number(getArg('port', process.env.ONEBOT_PORT || 3000));
const AS_JSON = args.includes('--json');

let token = getArg('token', process.env.ONEBOT_TOKEN || '');
if (!token) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    token = cfg?.snowluma?.accessToken || '';
  } catch { /* 没配置就匿名探测 */ }
}

const BASE = `http://127.0.0.1:${PORT}`;

// 探测表：action → 期望能力说明
const PROBES = [
  ['get_login_info', {}, '登录信息'],
  ['get_friend_list', {}, '好友列表（私聊准入用）'],
  ['fetch_custom_face_detail', { count: 5 }, '读收藏表情'],
  ['add_custom_face', { emoji_id: 'probe', emoji_package_id: '' }, '**写**收藏表情（收藏功能依赖）'],
  ['modify_custom_face', { emoji_id: 'probe', desc: 'probe' }, '改收藏表情备注']
];

async function call(action, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${BASE}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ action, params }),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    const wording = String(data?.wording || data?.message || '');
    const ok = data?.status === 'ok' || data?.retcode === 0;
    return {
      ok,
      status: data?.status ?? res.status,
      retcode: data?.retcode ?? null,
      wording: wording.slice(0, 80),
      count: Array.isArray(data?.data) ? data.data.length : null
    };
  } catch (e) {
    return { ok: false, status: 'error', wording: String(e?.name === 'AbortError' ? 'timeout' : (e?.message ?? e)).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const [action, params, label] of PROBES) {
  const r = await call(action, params);
  results.push({ action, label, ...r });
}

if (AS_JSON) {
  console.log(JSON.stringify({ port: PORT, results }, null, 2));
  process.exit(0);
}

console.log(`网关能力探测 @ ${BASE}${token ? '（带令牌）' : '（未带令牌）'}`);
console.log('');
for (const r of results) {
  const mark = r.ok ? '[可用]' : '[不支持]';
  const extra = r.count != null ? ` data=${r.count} 条` : '';
  console.log(`  ${mark} ${r.action.padEnd(26)} ${r.label}${extra}`);
  if (!r.ok && r.wording) console.log(`           └ ${r.wording}`);
}

const canCollect = results.find((r) => r.action === 'add_custom_face')?.ok === true;
const canRead = results.find((r) => r.action === 'fetch_custom_face_detail')?.ok === true;
console.log('');
if (canCollect) {
  console.log('  结论：可读可写 —— 收藏功能可用。');
} else if (canRead) {
  console.log('  结论：**只读** —— 能读收藏夹，不能收藏。');
  console.log('        表情策展只能记本地笔记（state/sticker-notes.json），不能真入库。');
  console.log('        要真收藏，请切回支持 add_custom_face 的网关（SnowLuma）。');
} else {
  console.log('  结论：收藏相关能力全部不可用。');
}
