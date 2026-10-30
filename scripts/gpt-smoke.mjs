#!/usr/bin/env node
/**
 * GPT 通道冒烟测试（**会花钱**，默认只做鉴权检查）。
 *
 *   node scripts/gpt-smoke.mjs                  # 只查 /v1/models（免费，验证 key 有效）
 *   node scripts/gpt-smoke.mjs --chat           # 再花 5 个 token 试一次补全（验额度和模型）
 *   node scripts/gpt-smoke.mjs --chat --model gpt-4o-mini --base https://api.openai.com/v1
 *
 * Key 来源（按顺序）：--key 参数 → 环境变量 OPENAI_API_KEY → 文件 state/openai-key.txt
 * **key 只从这三处读，绝不写进仓库**（state/ 已 gitignore，check-privacy 会拦 sk- 前缀）。
 *
 * 为什么要有它：2026-10-31 实测发现"key 有效但额度为 0"这种情况下，
 * 桥接侧只会看到 DSH 里的模型调用失败，排查时很容易怀疑到我们的代码上。
 * 先用这个脚本把「网络 / 鉴权 / 额度 / 模型 id」四件事分开验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const wantChat = argv.includes('--chat');
const base = (arg('--base', process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')).replace(/\/+$/, '');
const model = arg('--model', process.env.OPENAI_MODEL || 'gpt-4o-mini');

function readKey() {
  if (arg('--key')) return arg('--key').trim();
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  for (const rel of ['state/openai-key.txt', 'state/openai-key']) {
    const p = path.join(ROOT, rel);
    try { return fs.readFileSync(p, 'utf8').trim(); } catch {}
  }
  return '';
}

const key = readKey();
if (!key) {
  console.error('✗ 没拿到 key：用 --key、$env:OPENAI_API_KEY，或把 key 放到 state/openai-key.txt');
  process.exit(1);
}
console.log(`  key: ${key.slice(0, 7)}…（长度 ${key.length}）  base: ${base}`);

async function call(pathname, init = {}) {
  const res = await fetch(base + pathname, {
    ...init,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// ① 鉴权：/v1/models 不消耗额度
const models = await call('/models');
if (models.status !== 200) {
  console.error(`✗ 鉴权失败：HTTP ${models.status} ${models.text.slice(0, 200)}`);
  process.exit(1);
}
const ids = (models.json?.data ?? []).map((m) => m.id).sort();
console.log(`  ✓ 鉴权 OK：可见 ${ids.length} 个模型`);
const suspects = ['gpt-5', 'gpt-4.1', 'gpt-4o', 'o3', 'o4'];
const useful = ids.filter((id) => suspects.some((p) => id.startsWith(p)) && !/audio|realtime|transcribe|tts|image|search/.test(id));
console.log(`  文本类候选：${useful.slice(0, 10).join(', ') || '（没找到常见的聊天模型）'}`);

if (!wantChat) {
  console.log('\n  提示：加 --chat 才会真的发一次补全（花极少量 token，但能验证额度与模型是否可用）。');
  process.exit(0);
}

// ② 额度 + 模型：真正发一条最小补全
if (!ids.includes(model)) {
  console.warn(`  ⚠ ${model} 不在可见模型列表里，仍然尝试一次`);
}
const chat = await call('/chat/completions', {
  method: 'POST',
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 })
});

if (chat.status === 200) {
  const out = chat.json?.choices?.[0]?.message?.content ?? '';
  console.log(`  ✓ 补全成功：model=${model} 回复=${JSON.stringify(out).slice(0, 60)}`);
  console.log('\n下一步：DSH → Settings → Models 添加 provider（apiType=openai, baseUrl 同上），');
  console.log('        再把桥接 config.json 的 dsh.provider 改成那个 provider id、dsh.model 改成上面可用的 model。');
  process.exit(0);
}

const code = chat.json?.error?.code || chat.json?.error?.type || '';
if (chat.status === 429 && /quota|credit/i.test(chat.text)) {
  console.error(`✗ 额度不足：HTTP 429 ${code} —— key 本身有效，但账户没有可用余额。`);
  console.error('  这不是桥接的问题，也不是 provider 配置的问题；充值后重跑本脚本即可。');
  process.exit(2);
}
if (chat.status === 404 || /model/i.test(chat.text)) {
  console.error(`✗ 模型不可用：HTTP ${chat.status} ${chat.text.slice(0, 200)}`);
  console.error(`  从候选里换一个：${useful.slice(0, 5).join(', ')}`);
  process.exit(3);
}
console.error(`✗ 补全失败：HTTP ${chat.status} ${chat.text.slice(0, 300)}`);
process.exit(1);