#!/usr/bin/env node
/**
 * Pixiv 登录（PKCE）→ 拿 refresh_token 存 state/pixiv.json
 *
 * 用法：
 *   node tools/pixiv-auth.mjs --login     # 打印登录地址，浏览器登录后把回调地址/ code 粘回来
 *   node tools/pixiv-auth.mjs --status    # 看当前是否已登录、token 过期时间
 *
 * 为什么用 App API + refresh_token：网页端有 Cloudflare，脚本化容易被拦；
 * App API 只要 token 就能稳定搜/取详情。凭据只落 state/（已 gitignore）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { createLoginChallenge, exchangeCode, extractCode, readAuth, accessToken } from '../src/pixiv.js';

// Windows 中文路径在 URL 里是百分号编码的，必须用 fileURLToPath
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

if (has('--status')) {
  const auth = readAuth(STATE);
  if (!auth?.refresh_token) {
    console.log('未登录。跑：node tools/pixiv-auth.mjs --login');
    process.exit(1);
  }
  const exp = Number(auth.expires_at || 0) * 1000;
  const left = Math.max(0, Math.round((exp - Date.now()) / 1000));
  console.log(`已登录（user id: ${auth.user?.id ?? '?'}）`);
  console.log(`access_token 剩余 ${left} 秒${left > 0 ? '' : '（下次调用会自动 refresh）'}`);
  console.log(`文件：${path.join(STATE, 'pixiv.json')}`);
  process.exit(0);
}

if (!has('--login')) {
  console.log('用法：');
  console.log('  node tools/pixiv-auth.mjs --login     # 登录');
  console.log('  node tools/pixiv-auth.mjs --status    # 看状态');
  process.exit(2);
}

const PENDING = path.join(STATE, 'pixiv-pending.json');
const { verifier, url } = createLoginChallenge();
// 把 verifier 存下来：URL 可能贴到别的窗口、过一会儿才回填 code，
// 没有它换不了 token（PKCE 校验）。10 分钟后过期。
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(PENDING, JSON.stringify({ verifier, url, at: Date.now() }, null, 2), 'utf8');
console.log('');
console.log('1) 在浏览器里打开这个地址并登录（如果已经登录会直接跳转）：');
console.log('');
console.log('   ' + url);
console.log('');
console.log('2) 登录成功后页面会跳到一个打不开的地址（或显示「请复制下面的链接」），');
console.log('   把那个完整地址粘到下面（或只粘 code= 后面那段）：');
console.log('');

const codeArg = (() => { const i = argv.indexOf('--code'); return i >= 0 ? (argv[i + 1] ?? '') : ''; })();
let verifierToUse = verifier;
let pasted = codeArg;
if (codeArg) {
  // 非交互：verifier 只能从 pending 里取（同一次登录生成的才算数）
  try {
    const pend = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
    if (Date.now() - Number(pend.at || 0) > 10 * 60 * 1000) throw new Error('登录地址已过期（超过 10 分钟），重新跑 --login');
    verifierToUse = pend.verifier;
  } catch (e) {
    console.error('   ✗ 找不到有效的登录地址（pending 缺失/过期）：' + (e?.message ?? e));
    process.exit(1);
  }
} else {
  pasted = await ask('   回调地址/code: ');
}
const code = extractCode(pasted);
if (!code) {
  console.error('   ✗ 没从输入里解析出 code，把完整回调地址再试一次');
  process.exit(1);
}

try {
  const auth = await exchangeCode({ stateDir: STATE, code, verifier: verifierToUse });
  fs.mkdirSync(STATE, { recursive: true });
  const expLeft = Math.round((Number(auth.expires_at) * 1000 - Date.now()) / 1000);
  console.log('');
  console.log(`   ✓ 登录成功（user id: ${auth.user?.id ?? '?'}），token 已写入 state/pixiv.json`);
  console.log(`     access_token 有效期 ${expLeft} 秒；之后会自动用 refresh_token 续`);
  // 立刻验一次：能拉到排行榜就说明 token 可用
  try {
    await accessToken(STATE, { forceRefresh: true });
    console.log('     续期测试：通过');
  } catch (e) {
    console.log('     续期测试：失败（' + (e?.message ?? e) + '）');
  }
} catch (e) {
  console.error('   ✗ ' + (e?.message ?? e));
  process.exit(1);
}
