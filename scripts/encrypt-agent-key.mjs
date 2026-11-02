// 把 config.json 里的明文 API Key 加密（0.5.50 · P1）
//
// 用法：
//   node scripts/encrypt-agent-key.mjs            # 加密并清除明文
//   node scripts/encrypt-agent-key.mjs --check    # 只看当前是否明文
//
// 为什么要单独一条命令：加解密依赖「本机」（Windows DPAPI / 本地密钥文件），
// 不能像别的字段那样在 loadConfig 里顺手做 —— 那会让每次启动都多一次 PowerShell。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecretBox } from '../src/secret-box.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --config <path> 指定要处理的 config.json（部署目录与仓库不是同一个时必用）
const cfgArg = process.argv.indexOf('--config');
const cfgFile = cfgArg > 0 && process.argv[cfgArg + 1]
  ? path.resolve(process.argv[cfgArg + 1])
  : path.join(root, 'config.json');
const checkOnly = process.argv.includes('--check');

const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, ''));
const agent = cfg.agent || {};
const plain = String(agent.apiKey || '');
const enc = String(agent.apiKeyEnc || '');

if (!plain && !enc) {
  console.log('  没有 agent.apiKey，也没有 apiKeyEnc —— 不需要处理');
  process.exit(0);
}
if (!plain && enc) {
  console.log('  ✓ agent.apiKey 已经是密文（apiKeyEnc），不需要处理');
  process.exit(0);
}
if (checkOnly) {
  console.log('  ⚠ agent.apiKey 是明文 —— 跑一次不带 --check 就会加密');
  process.exit(1);
}

const box = createSecretBox();
const cipher = box.protect(plain);
if (!cipher) { console.error('  ✗ 加密失败（DPAPI/密钥文件不可用）'); process.exit(1); }
if (box.unprotect(cipher) !== plain) { console.error('  ✗ 自检失败：加密后解不回来，已放弃写入'); process.exit(1); }

cfg.agent = { ...agent, apiKeyEnc: cipher, apiKey: '' };
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log(`  ✓ 已加密：${cipher.slice(0, 12)}…（长度 ${cipher.length}）`);
console.log('  明文已清空；重启桥接后生效。');
