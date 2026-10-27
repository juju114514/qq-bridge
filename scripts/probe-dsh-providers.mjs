// 探测 DSH 到底提供哪些 provider / model（决定「适配 GPT」要做什么）
//
// 背景：桥接本身不直连模型厂商——它把 provider/model 交给 DSH，并**从 DSH 的
// `session.modelCatalog` 读能力清单**（思考强度档位、模型列表都来自这里）。
// 所以「支持 GPT」= DSH 里有没有一个 OpenAI 兼容的 provider。
//
// 用法：node scripts/probe-dsh-providers.mjs
import { NodeApiClient, isLoopbackBase, resolveDshHome } from '../src/dsh-client.js';
import fs from 'node:fs';
import path from 'node:path';

const home = resolveDshHome();
const cfgFile = path.join(home, '..', 'qq-bridge', 'config.json');
let baseUrl = 'http://127.0.0.1:54694';
try {
  const raw = fs.readFileSync('config.json', 'utf8');
  baseUrl = JSON.parse(raw)?.dsh?.baseUrl || baseUrl;
} catch { /* 用默认 */ }

console.log(`  DSH_HOME = ${home}`);
console.log(`  baseUrl  = ${baseUrl}  (loopback: ${isLoopbackBase(baseUrl)})`);

// 构造签名是 (baseUrl, timeoutMs, auth)：第二个参数必须是数字，第三个才是鉴权。
// 第一次我把 cookie 传在第二个位置，结果报 “delay argument must be a number”。
const api = new NodeApiClient(baseUrl, undefined, {
  token: '',
  tokenExplicit: false,
  header: 'authorization',
  prefix: 'Bearer',
  allowRemote: false,
});

async function call(method, params = {}) {
  try {
    return await api.callUnary(method, params);
  } catch (error) {
    return { __error: String(error?.message ?? error) };
  }
}

const catalog = await call('session.modelCatalog');
if (catalog.__error) {
  console.log(`  ✗ session.modelCatalog 失败：${catalog.__error}`);
} else {
  const groups = catalog?.result?.groups ?? catalog?.groups ?? [];
  console.log(`  模型目录分组数：${groups.length}`);
  for (const g of groups) {
    const models = (g.models ?? []).map((m) => m.id).join(', ');
    console.log(`    - provider=${g.id}  models=[${models}]`);
    for (const m of (g.models ?? [])) {
      if (m.reasoningEfforts || m.reasoning) {
        console.log(`        ${m.id}: reasoning=${JSON.stringify(m.reasoningEfforts ?? m.reasoning)}`);
      }
    }
  }
  if (!groups.length) console.log('    （空清单：DSH 可能没配置任何 provider）');
}

const settings = await call('settings.describe');
if (settings.__error) {
  console.log(`  ✗ settings.describe 失败：${settings.__error}`);
} else {
  // 把 settings 里与「provider / 模型接入」相关的路径打出来（值一律脱敏）
  const text = JSON.stringify(settings);
  const seen = [];
  (function walk(node, prefix, depth) {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      const lk = k.toLowerCase();
      if (/provider|openai|anthropic|baseurl|apikey|api_key|model|kind|endpoint|custom/i.test(lk)) {
        seen.push(`${p} = ${typeof v === 'object' ? (Array.isArray(v) ? `[${v.length}]` : '{…}') : JSON.stringify(v)}`);
      }
      if (typeof v === 'object') walk(v, p, depth + 1);
    }
  })(settings, '', 0);
  // providers 映射的键（决定「DSH 现在认识哪些 provider」）
  try {
    const ns = settings?.result?.value?.namespaces ?? [];
    for (const n of ns) {
      const provs = n?.value?.providers;
      if (provs && typeof provs === 'object') {
        console.log(`  providers 命名空间=${n.id ?? n.name ?? '?'} 里的 provider：`);
        for (const [id, v] of Object.entries(provs)) {
          const keys = v && typeof v === 'object' ? Object.keys(v).join(',') : typeof v;
          console.log(`    - ${id}  {${keys}}`);
        }
      }
    }
  } catch (e) {
    console.log(`  （解析 providers 失败：${e.message}）`);
  }

  console.log('  settings 里与「模型接入」相关的路径：');
  for (const line of [...new Set(seen)].slice(0, 40)) {
    const masked = line.replace(/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1***');
    console.log(`    ${masked}`);
  }
  const hints = ['openai', 'anthropic', 'gemini', 'azure', 'custom', 'baseUrl', 'base_url', 'apiKey', 'api_key'];
  const found = hints.filter((h) => text.toLowerCase().includes(h.toLowerCase()));
  console.log(`  settings 里出现的关键词：${found.join(', ') || '（无）'}`);
  console.log(`  settings 体积：${text.length} 字节`);
}
