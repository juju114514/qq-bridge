#!/usr/bin/env node
/**
 * 隐私守卫：确保"本机私有信息"没有进仓库。
 *
 * 为什么需要它：
 *   2026-10-31 收工时全仓扫描，发现**主人的真实 QQ、机器人的真实 QQ、以及被授权群的群号**
 *   散落在文档示例和测试夹具里（已经公开推上 GitHub 好几个提交）。
 *   这类东西一旦进历史，改 HEAD 是清不掉的 —— 只能在推之前拦住。
 *
 * 检查四类：
 *   1. 不该被跟踪的文件（状态/凭证/备份/锁）
 *   2. 本机私有路径（工作区目录、开发目录、用户目录）
 *   3. 令牌形态的字符串（32 位以上的 hex / base64）
 *   4. 本机 deny-list（通过环境变量 QQB_PRIVACY_DENY 提供，逗号分隔；不进仓库）
 *
 * 用法：
 *   node scripts/check-privacy.mjs
 *   $env:QQB_PRIVACY_DENY = "123456789,987654321"   # 可选，本地/CI 各配各的
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    console.error('✗ 隐私守卫：拿不到 git 文件列表（这里必须是 git 仓库）');
    process.exit(1);
  }
}

const FORBIDDEN_FILES = [
  /^state\//,
  /^config\.json$/,
  /^\.env$/,
  /official\.json$/,
  /console-token$/,
  /inject-token$/,
  /\.bak-/,
  /\.corrupt-\d+$/,
  /^logs\//
];

// 本机私有路径：出现即视为泄露（文档示例也不许，因为是真实目录）
const FORBIDDEN_PATHS = [
  /D:\\deepseek工作区/i,
  /D:\\QQBot-open/i,
  /C:\\Users\\Administrator/i,
  /D:\\QQBot\\temp/i
];

// 令牌形态：
//   · 32 位以上连续 hex（QQ token / agentToken / console-token 都长这样）
//   · 各家 API key 的前缀（sk- / sk-proj- / AKIA / ghp_ …）—— 2026-10-31 加，
//     因为 OpenAI key 是 base64 形态，光看 hex 抓不到
const TOKEN_LIKE = /\b[0-9a-f]{32,}\b|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{30,}/i;

// 允许"看起来像令牌"的白名单文件（例如测试夹具里显式构造的假 token）
const TOKEN_ALLOW = [
  /^scripts\/test-.*\.mjs$/,
  // 审计用的 harness 里有显式构造的假令牌（AABBCCDD…），是夹具不是凭证
  /^scripts\/audit-bridge-harness\.mjs$/,
  /^docs\//,
  // preset 的部署产物是**生成文件**：首行是 build-presets.mjs 写入的 source-sha256，
  // 那是哈希不是凭证，且已由 check-preset-fresh.mjs 校验「产物 == 真源」。
  /^dsh\/agent-presets\/[^/]+\/qq-tool-restrict\.mjs$/
];

const problems = [];
const files = trackedFiles();

for (const f of files) {
  if (FORBIDDEN_FILES.some((re) => re.test(f))) problems.push(`${f}: 不该被跟踪（状态/凭证/备份）`);
}

const deny = String(process.env.QQB_PRIVACY_DENY || '')
  .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

for (const f of files) {
  let text;
  try {
    const abs = path.join(ROOT, f);
    const stat = fs.statSync(abs);
    if (stat.size > 2 * 1024 * 1024) continue;      // 大文件跳过（多半是图片/产物）
    text = fs.readFileSync(abs, 'utf8');
  } catch { continue; }
  if (text.includes('\u0000')) continue;            // 二进制

  for (const re of FORBIDDEN_PATHS) {
    const m = re.exec(text);
    if (m) problems.push(`${f}: 含本机私有路径「${m[0]}」`);
  }

  if (!TOKEN_ALLOW.some((re) => re.test(f)) && TOKEN_LIKE.test(text)) {
    const m = TOKEN_LIKE.exec(text);
    problems.push(`${f}: 含令牌形态字符串「${m[0].slice(0, 8)}…」`);
  }

  for (const id of deny) {
    if (text.includes(id)) problems.push(`${f}: 含本机 deny-list 里的标识符（${id.slice(0, 3)}…）`);
  }
}

if (problems.length) {
  console.error('✗ 隐私守卫：');
  for (const p of problems) console.error('   ' + p);
  console.error('\n  修法：把真实号码/路径换成占位（如 123456789 / <你的QQ号>），凭证放 state/（已 gitignore）。');
  process.exit(1);
}

const note = deny.length ? `（deny-list ${deny.length} 项）` : '（未设 QQB_PRIVACY_DENY，跳过本机标识符检查）';
console.log(`✓ 隐私守卫：${files.length} 个被跟踪文件里没有私有路径/凭证/明文令牌 ${note}`);