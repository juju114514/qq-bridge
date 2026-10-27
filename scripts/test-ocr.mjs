// OCR（Windows.Media.Ocr）与「长图优先 OCR」的契约测试。
//
// 为什么要钉：
//   · 长截图切成 5 片 ≈1.5 万 token，OCR 出文字只要几百 token —— 这是**成本**契约，
//     被"优化"回"一律给图"就是几百倍差价。
//   · Windows OCR 会在汉字之间插空格（`这 是 第 1 行`），不归一化等于白省。
//   · 非 Windows / 没装语言包时必须**优雅降级**（退回切片），不能抛异常把整条消息打断。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ocrAvailable, ocrImage, normalizeOcrText } from '../src/ocr.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

// ── 1. 文字归一化（纯函数，任何平台都跑）────────────────────────────────
await check('normalizeOcrText：删掉汉字间的空格，但保留半角标点后的空格', () => {
  const cases = [
    ['这 是 第 1 行 测 试 文 本', '这是第 1 行测试文本'],
    ['[ 001 ] krystal: 这 是 第 1 行 ， 好 的', '[ 001 ] krystal: 这是第 1 行，好的'],
    ['hello world  多 空 格', 'hello world 多空格'],
    ['（ 括 号 ） 测 试', '（括号）测试'],
    ['多\n\n\n\n空行', '多\n\n空行'],
    ['', ''],
  ];
  for (const [input, want] of cases) {
    assert.equal(normalizeOcrText(input), want, `输入 ${JSON.stringify(input)}`);
  }
});

await check('normalizeOcrText 不吞纯英文里的空格', () => {
  assert.equal(normalizeOcrText('hello   world  @user'), 'hello world @user');
  assert.equal(normalizeOcrText('a b c'), 'a b c');
});

// ── 2. 降级行为（不依赖 OCR 是否可用）───────────────────────────────────
await check('非 Windows / 无脚本时 ocrImage 返回 ok:false 而不是抛异常', async () => {
  if (ocrAvailable()) {
    console.log('       （当前环境 OCR 可用，跳过降级断言）');
    return;
  }
  const r = await ocrImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(r.ok, false);
  assert.ok(r.reason, '必须带 reason，调用方据此退回切片');
});

await check('空字节直接拒绝（不打 spwan 进程）', async () => {
  const r = await ocrImage(Buffer.alloc(0));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-image');
});

// ── 3. 真 OCR（有 Windows OCR 才跑）─────────────────────────────────────
if (ocrAvailable()) {
  await check('真 OCR：识别一张带中文的图，且结果里没有"汉 字 之 间 的 空 格"', async () => {
    // 用 ffmpeg 造图太依赖字体；这里直接找仓库里现成的截图素材，没有就跳过
    const candidates = [
      path.join(root, 'assets', 'social-preview.png'),
    ].filter((p) => fs.existsSync(p));
    if (!candidates.length) {
      console.log('       （没有可用素材，跳过真 OCR）');
      return;
    }
    const buf = fs.readFileSync(candidates[0]);
    const r = await ocrImage(buf, { mimeType: 'image/png', timeoutMs: 60000 });
    assert.equal(r.ok, true, `OCR 失败：${r.error}`);
    assert.ok(typeof r.text === 'string');
    assert.ok(r.width > 0 && r.height > 0, '应返回图片尺寸');
    assert.doesNotMatch(r.text, /[\u4e00-\u9fff] [\u4e00-\u9fff]/, '中文之间的空格必须被抹掉');
  });
}

// ── 4. 接线（源码契约：改实现别改坏这三处）──────────────────────────────
await check('bridge：fetchMediaData 支持 mode，且长图（≥2.4）先 OCR', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /async function fetchMediaData\(mediaList, opts = \{\}\)/);
  assert.match(bridge, /\['auto', 'text', 'image'\]\.includes/, 'mode 必须是这三个值');
  assert.match(bridge, />= 2\.4/, '长图判定阈值要写进代码（与 media-normalize 的 sliceAspectMin 一致）');
  assert.match(bridge, /ocrText/, 'OCR 结果要以 ocrText 返回给 MCP');
  assert.match(bridge, /mode=image/, '说明里要告诉模型怎么要原图');
});

await check('api/images.js：解析 mode 并透传，响应里回显 mode', () => {
  const api = read('src/api/images.js');
  assert.match(api, /searchParams\?\.get\('mode'\)/);
  assert.match(api, /fetchMediaData\(media, \{ mode \}\)/);
  assert.match(api, /sendJson\(\{ ok: true, messageId, media, mode, images \}\)/);
});

await check('MCP 工具：暴露 mode 参数，并把 ocrText 当文本内容返回（不占图片 token）', () => {
  const mcp = read('src/mcp-snowluma-safe.js');
  assert.match(mcp, /mode: z\.enum\(\['auto', 'text', 'image'\]\)/, 'schema 要有 mode');
  assert.match(mcp, /q\.set\('mode'/, 'mode 要带到请求上');
  assert.match(mcp, /img\?\.ocrText/, '要识别 ocrText');
  assert.match(mcp, /content\.push\(\{ type: 'text', text: String\(img\.ocrText\) \}\)/, 'ocrText 应以文本返回');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
