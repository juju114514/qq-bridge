// 非 DeepSeek provider 的思考强度适配（真机踩出来的回归）。
//
// 现象（2026-10-31）：把 dsh.provider 指向 dashscope/qwen-flash、amazon-bedrock/nova-lite 这类
// "模型不声明 reasoning 档位"的提供商时，DSH 回：
//   session/model-unavailable: provider "dashscope" model "qwen-flash" does not support reasoning effort "low"
// 而 ensureChatModel 以前只把同一个请求重试两次 → 必然失败、静默退回默认模型（用户只看到"回复不像那个模型"）。
//
// 修法：第一次照配置发；报 "reasoning effort" 相关错误时，**去掉该字段**重试一次。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e?.message ?? e)]); }
}

check('ensureChatModel 有"去掉 reasoningEffort 重试"的分支', () => {
  assert.match(bridge, /omitEffort/, '需要有 omitEffort 开关');
  assert.match(bridge, /if \(!omitEffort\) payload\.reasoningEffort = effort;/, '默认仍带 effort');
  assert.match(bridge, /reasoning effort/i, '要按错误文本识别"不支持思考强度"');
  assert.match(bridge, /改为不带该字段重试/, '要留一行可读日志（否则排查时看不出为什么成功了）');
});

check('DeepSeek 路径不变：第一次仍然带 reasoningEffort', () => {
  const i = bridge.indexOf('async function ensureChatModel');
  const seg = bridge.slice(i, i + 2600);
  assert.match(seg, /const effort = String\(cfg\.dsh\?\.reasoningEffort \|\| REASONING_EFFORT_DEFAULT\);/);
  assert.ok(seg.indexOf('payload.reasoningEffort = effort') < seg.indexOf('omitEffort = true'),
    '顺序必须先是"带字段"，失败后才省略');
});

check('思考强度白名单仍然是 low/high/max（控制台只提供这三档）', () => {
  assert.match(bridge, /REASONING_EFFORT_OPTIONS = \['low', 'high', 'max'\]/);
});

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, name] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${name}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);