#!/usr/bin/env node
// 把 SnowLuma 当前账号的 token 同步到两处配置：
//   1) <repo>/config.json        的 snowluma.accessToken   （桥接用于 HTTP 调用）
//   2) DSH profile 的 cordis.patch.yml 里 qq-bridge 插件的 accessToken（插件用于 WS 连接）
//
// 为什么需要：SnowLuma 的 HTTP token 与 **WS token 是两个不同的值**，重新扫码后都会变。
// 而插件只认 WS 那个；写错的话表现为"TCP 连上就断、错误信息还是空的"，很难查。
//
// 用法：
//   node scripts/sync-snowluma-token.mjs                 # 直接改
//   node scripts/sync-snowluma-token.mjs --dry           # 只看会改什么
//   node scripts/sync-snowluma-token.mjs --show          # 额外打印 token 前 4 位（默认不打印）
//   node scripts/sync-snowluma-token.mjs --profile <dir> # 指定 DSH profile 目录
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snowLumaHomeCandidates,
  readOneBotTokens,
} from '../src/snowluma-conn.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const SHOW = args.includes('--show');
const profileArg = args.indexOf('--profile');
const profileDir = profileArg >= 0
  ? path.resolve(args[profileArg + 1] ?? '')
  : path.join(os.homedir(), '.dsh', 'profiles', 'desktop');

const mask = (t) => (!t ? '(空)' : SHOW ? t : t.slice(0, 4) + '…(' + t.length + ' 位)');

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

function main() {
  const cfgPath = path.join(repoRoot, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error('✗ 找不到 ' + cfgPath + '（请在仓库根目录运行）');
    process.exit(1);
  }
  const cfg = loadJson(cfgPath);
  const homes = snowLumaHomeCandidates({ cfg: cfg.snowluma ?? cfg });
  if (!homes.length) {
    console.error('✗ 配置里没有 snowluma.homeDir / launcherPath，也没有 SNOWLUMA_HOME 环境变量');
    console.error('  请在 config.json 的 snowluma.homeDir 填上 SnowLuma 安装目录后重试');
    process.exit(1);
  }

  let accounts = [];
  for (const home of homes) accounts = accounts.concat(readOneBotTokens(home));
  if (!accounts.length) {
    console.error('✗ 在下面这些目录里没找到 config/onebot_<QQ>.json：');
    homes.forEach((h) => console.error('   ' + h));
    console.error('  —— 说明 SnowLuma 还没登录过，或者 homeDir 指错了');
    process.exit(1);
  }

  // 机器人自己的号优先；ownerQQ 是"人"，不是登录账号，别拿它当首选匹配键
  const selfHints = [cfg.selfQQ, cfg.qq, cfg.botQQ, cfg.snowluma?.selfQQ]
    .map((x) => String(x ?? '')).filter(Boolean);
  let pick = accounts.find((a) => selfHints.includes(a.uin));
  if (!pick) {
    if (accounts.length > 1) {
      console.warn('  ! SnowLuma 里登录了 ' + accounts.length + ' 个账号，无法确定用哪个：');
      accounts.forEach((a) => console.warn('     ' + a.uin + '  ' + a.file));
      console.warn('    先取第一个（' + accounts[0].uin + '）；想固定请给 config.json 加 selfQQ');
    }
    pick = accounts[0];
  }
  const wsToken = pick.ws?.token ?? '';
  const httpToken = pick.http?.token ?? '';
  console.log('  SnowLuma 账号: ' + pick.uin + '（' + pick.file + '）');
  console.log('  WS token : ' + mask(wsToken));
  console.log('  HTTP token: ' + mask(httpToken));
  if (!wsToken) {
    console.error('✗ 这个账号的配置里没有 wsServers[0].accessToken —— 先在 SnowLuma 里开启 WS 服务');
    process.exit(1);
  }

  // 1) 桥接 config.json：snowluma.accessToken（HTTP 用；桥接自己会再加 WS 的）
  const before = String((cfg.snowluma ?? {}).accessToken ?? '');
  const target = httpToken || wsToken;
  if (before === target) {
    console.log('  · config.json 的 snowluma.accessToken 已是最新');
  } else if (DRY) {
    console.log('  [dry] 会改 config.json: snowluma.accessToken ' + mask(before) + ' → ' + mask(target));
  } else {
    cfg.snowluma = { ...(cfg.snowluma ?? {}), accessToken: target };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    console.log('  ✓ config.json: snowluma.accessToken 已更新（' + mask(before) + ' → ' + mask(target) + '）');
  }

  // 2) DSH profile：cordis.patch.yml 里 qq-bridge 的 accessToken（插件用 WS token）
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(patchPath)) {
    console.log('  ! 跳过插件配置：找不到 ' + patchPath);
    return;
  }
  const text = fs.readFileSync(patchPath, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^-\s+id:\s*qq-bridge\s*$/.test(l));
  if (start < 0) {
    console.log('  ! 跳过插件配置：' + patchPath + ' 里没有 qq-bridge 条目');
    return;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s+/.test(lines[i])) { end = i; break; }
  }
  let changed = false;
  for (let i = start + 1; i < end; i += 1) {
    if (/^\s+accessToken:\s*/.test(lines[i])) {
      const old = lines[i].replace(/^\s+accessToken:\s*/, '').replace(/^['"]|['"]$/g, '');
      if (old === wsToken) {
        console.log('  · 插件的 accessToken 已是最新');
      } else if (DRY) {
        console.log('  [dry] 会改插件 accessToken: ' + mask(old) + ' → ' + mask(wsToken));
      } else {
        lines[i] = lines[i].replace(/^(\s+accessToken:\s*).*$/, "$1'" + wsToken + "'");
        changed = true;
        console.log('  ✓ 插件 accessToken 已更新（' + mask(old) + ' → ' + mask(wsToken) + '）');
      }
      break;
    }
  }
  if (changed) {
    fs.writeFileSync(patchPath, lines.join('\n'), 'utf8');
    console.log('  ✓ 已写入 ' + patchPath);
    console.log('  ⚠️ 插件在 DSH 启动时加载：**重启 DSH 才会生效**');
  } else if (!DRY) {
    console.log('  （插件配置无需改动）');
  }
}

main();