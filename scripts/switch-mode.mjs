#!/usr/bin/env node
// 双模式开关：同一套 state/ 只能有一个东西收 QQ（通道互斥）。这里做"选哪条路"。
//
//   node scripts/switch-mode.mjs status    # 看现在谁在收（默认）
//   node scripts/switch-mode.mjs bridge    # 路线 A：常驻 bridge 收 QQ（插件让出）
//   node scripts/switch-mode.mjs plugin    # 路线 B：DSH 插件收 QQ（bridge 只当 sidecar）
//
// 改两个文件 + 重启需要重启的东西；不会替你重启 DSH（那是 GUI）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const args = process.argv.slice(2);
const mode = (args.find((a) => ['status', 'bridge', 'plugin'].includes(a)) ?? 'status');
const DRY = args.includes('--dry');
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const cfgPath = path.resolve(getArg('--config', path.join(repoRoot, 'config.json')));
const profileDir = path.resolve(getArg('--profile', path.join(os.homedir(), '.dsh', 'profiles', 'desktop')));
const patchPath = path.join(profileDir, 'cordis.patch.yml');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const stateFile = path.join(path.dirname(cfgPath), 'state', 'channel-mode.json');

function describe() {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const age = Math.round((Date.now() - Number(j.at ?? 0)) / 1000);
    return `通道当前持有者：${j.mode}（pid ${j.pid}，${age}s 前心跳）`;
  } catch {
    return '通道当前无人持有（channel-mode.json 不存在）';
  }
}

function patchPluginEnabled(enabled) {
  if (!fs.existsSync(patchPath)) return '（没找到 profile 的 cordis.patch.yml，跳过插件配置）';
  const lines = fs.readFileSync(patchPath, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^-\s+id:\s*qq-bridge\s*$/.test(l));
  if (start < 0) return '（profile 里没有 qq-bridge 条目，跳过）';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^-\s+/.test(lines[i])) { end = i; break; }
  let done = false;
  for (let i = start + 1; i < end; i += 1) {
    if (/^\s+enabled:\s*/.test(lines[i])) {
      const old = lines[i].trim();
      lines[i] = lines[i].replace(/^(\s+enabled:\s*).*$/, `$1${enabled}`);
      done = true;
      if (!DRY) fs.writeFileSync(patchPath, lines.join('\n'), 'utf8');
      return `插件 enabled：${old} → enabled: ${enabled}`;
    }
  }
  if (!done) {
    lines.splice(start + 1, 0, `    enabled: ${enabled}`);
    if (!DRY) fs.writeFileSync(patchPath, lines.join('\n'), 'utf8');
    return `插件 enabled：新增 enabled: ${enabled}`;
  }
  return '（无变化）';
}

function setBridgeChannel(enabled) {
  const cfg = readJson(cfgPath);
  const before = cfg.channel?.enabled !== false;
  if (before === enabled) return `桥接 channel.enabled 已是 ${enabled}`;
  cfg.channel = { ...(cfg.channel ?? {}), enabled };
  if (!DRY) fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return `桥接 channel.enabled：${before} → ${enabled}`;
}

if (mode === 'status') {
  const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  const bridgeOn = cfg.channel?.enabled !== false;
  console.log(describe());
  console.log(`桥接配置：channel.enabled = ${bridgeOn}（${bridgeOn ? '会收 QQ' : 'sidecar-only'}）`);
  if (fs.existsSync(patchPath)) {
    const text = fs.readFileSync(patchPath, 'utf8');
    const m = text.match(/-\s+id:\s*qq-bridge[\s\S]*?enabled:\s*(\w+)/);
    console.log(`插件配置：qq-bridge enabled = ${m ? m[1] : '(未配置，默认 false)'}`);
  }
  process.exit(0);
}

console.log(`── 切到【${mode === 'bridge' ? '路线 A：常驻 bridge 收 QQ' : '路线 B：DSH 插件收 QQ'}】${DRY ? '（dry-run）' : ''} ──`);
if (mode === 'bridge') {
  console.log('  ' + setBridgeChannel(true));
  console.log('  ' + patchPluginEnabled(false));
  console.log('');
  console.log('  接下来：');
  console.log('   1) 重启 DSH（让插件释放通道）  ← 必须做，否则桥接抢不到');
  console.log('   2) 重启桥接：schtasks /end /tn qq-bridge && schtasks /run /tn qq-bridge');
} else {
  console.log('  ' + setBridgeChannel(false));
  console.log('  ' + patchPluginEnabled(true));
  console.log('');
  console.log('  接下来：');
  console.log('   1) 重启桥接（让它让出通道）：schtasks /end /tn qq-bridge && schtasks /run /tn qq-bridge');
  console.log('   2) 重启 DSH（让插件接管）');
}
console.log('');
console.log('  ' + describe());