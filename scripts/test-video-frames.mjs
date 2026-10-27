// 视频理解（抽帧故事板 + 声音转写）的契约测试。
//
// 为什么值得钉：
//   · 模型看不了视频，唯一入口是"一张故事板 + 一段转写"——布局算错就是看错东西；
//   · 时长拿不到时按上限取点会产生不存在的时刻（黑格），所以 probeVideo 必须先跑通；
//   · ASR 服务没开时必须降级成"只有画面"，不能把整条消息读失败。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const mod = await import(new URL('../src/media-normalize.js', import.meta.url).href);
const { planVideoFrames, normalizeVideoForModel, probeVideo, extractVideoAudio, MEDIA_DEFAULTS } = mod;

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

const FF = process.env.FFMPEG_PATH || 'D:/QQBot/ffmpeg/ffmpeg.exe';
const hasFfmpeg = fs.existsSync(FF) || spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const ff = fs.existsSync(FF) ? FF : 'ffmpeg';

// ── 1. 布局（纯函数）──────────────────────────────────────────────────────
await check('planVideoFrames：时长决定帧数，采样点均匀且落在片内', () => {
  const short = planVideoFrames({ durationSec: 8, width: 1280, height: 720 }, {});
  assert.equal(short.count, 8, '8 秒应该按秒取 8 帧');
  assert.equal(short.cols * short.rows >= short.count, true, '格子必须装得下');
  for (const t of short.times) assert.ok(t > 0 && t < 8, `采样点 ${t} 超出片长`);

  const long = planVideoFrames({ durationSec: 75 }, {});
  assert.equal(long.count, MEDIA_DEFAULTS.videoFrames, '长视频取满上限帧');
  for (const t of long.times) assert.ok(t > 0 && t < 75);

  const capped = planVideoFrames({ durationSec: 600 }, {});
  assert.equal(capped.truncated, true, '超过 180 秒要标"只看了一部分"');
  assert.ok(Math.max(...capped.times) <= MEDIA_DEFAULTS.videoMaxSeconds);
});

await check('planVideoFrames：格子宽度不越过 maxLongEdge（否则整张再被缩，字就糊了）', () => {
  const p = planVideoFrames({ durationSec: 30 }, { videoCellWidth: 1024, videoCols: 3, maxLongEdge: 1280 });
  assert.ok(p.cols * p.cellW + 4 * (p.cols + 1) <= 1280, `宽度 ${p.cellW}×${p.cols} 超了 1280`);
});

await check('planVideoFrames：没有时长信息时不会算出 0 帧', () => {
  const p = planVideoFrames({}, {});
  assert.ok(p.count >= 1);
  assert.ok(p.fps > 0);
});

// ── 2. 真跑：合成视频 → 探元数据 → 抽故事板 → 抽音轨 ──────────────────────
if (!hasFfmpeg) {
  console.log('  skip 真抽帧（没有 ffmpeg）');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-vid-'));
  const video = path.join(tmp, 'test.mp4');
  const gen = spawnSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], { stdio: 'ignore', timeout: 120000 });

  await check('probeVideo：拿到时长/尺寸/有没有音轨', async () => {
    assert.equal(gen.status, 0, '合成测试视频失败');
    const meta = await probeVideo(video);
    assert.equal(meta.ok, true, meta.error);
    assert.ok(Math.abs(meta.durationSec - 6) < 1, `时长应约 6 秒，实际 ${meta.durationSec}`);
    assert.equal(meta.width, 640);
    assert.equal(meta.height, 360);
    assert.equal(meta.hasAudio, true);
  });

  await check('normalizeVideoForModel：产出一张拼好的故事板 JPEG（≤1MB）', async () => {
    const meta = await probeVideo(video);
    const board = await normalizeVideoForModel(video, { durationSec: meta.durationSec, width: meta.width, height: meta.height });
    assert.equal(board.ok, true, board.error);
    assert.equal(board.mimeType, 'image/jpeg');
    assert.ok(board.buffer.length > 5000, '故事板太小，可能是空图');
    assert.ok(board.buffer.length <= MEDIA_DEFAULTS.maxModelBytes, '故事板超过单张上限');
    assert.match(board.note, /抽 \d+ 帧拼成 \d+×\d+ 故事板/);
    assert.ok(fs.existsSync(video));
  });

  await check('extractVideoAudio：抽出 16k 单声道 wav', async () => {
    const aud = await extractVideoAudio(video, {});
    assert.equal(aud.ok, true, aud.error);
    const size = fs.statSync(aud.file).size;
    assert.ok(size > 1000, `音轨太小：${size}`);
    aud.cleanup();
    assert.equal(fs.existsSync(aud.file), false, 'cleanup 应该删掉临时目录');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 3. 接线（源码契约）────────────────────────────────────────────────────
await check('bridge：video 段入库 + 走"故事板 + 转写" + ASR 不可用要降级', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /seg\.type === 'video'/, 'OneBot 的 video 段必须被识别');
  assert.match(bridge, /kind: 'video'/, '媒体条目要带 kind:video');
  assert.match(bridge, /async function videoToModelParts/, '视频要有单独的组装函数');
  assert.match(bridge, /safeDownloadToFile/, '视频必须流式下载（不能整段进内存）');
  assert.match(bridge, /probeVideo/, '必须先探时长再抽帧');
  assert.match(bridge, /没有声音转写/, 'ASR 不可用时要写出原因，而不是静默丢');
  assert.match(bridge, /\/api\/socialV2\/video/, '要有独立端点');
});

await check('OCR/ASR 这类旁路服务都"只探测、不代启动"', () => {
  const asr = read('src/audio-transcribe.js');
  assert.match(asr, /\/health/, 'ASR 可用性靠 /health 探测');
  assert.doesNotMatch(asr, /spawn\s*\(/, 'ASR 客户端不该自己拉进程');
  assert.match(asr, /reason/, '失败要带 reason 供降级判断');
});

await check('MCP 暴露 qq_get_message_video（两种 mode）', () => {
  const mcp = read('src/mcp-snowluma-safe.js');
  assert.match(mcp, /'qq_get_message_video'/);
  assert.match(mcp, /mode: z\.enum\(\['storyboard', 'transcript'\]\)/);
  assert.match(mcp, /api\/socialV2\/video/);
});

await check('mode=transcript 能贯通到 endpoint（不被 mode 白名单吞成 auto）', () => {
  const api = read('src/api/images.js');
  assert.match(api, /\['auto', 'text', 'image', 'transcript'\]/, '白名单要含 transcript，否则视频只能出故事板');
  const bridge = read('src/bridge.js');
  assert.match(bridge, /opts\.mode === 'transcript'/, 'bridge 要按 transcript 分支');
});

await check('配置项齐全（开不了就整体关掉，不影响图片链路）', () => {
  const cfg = JSON.parse(read('config.example.json'));
  const v = cfg?.socialV2?.media?.video;
  assert.ok(v, 'config.example.json 缺 socialV2.media.video');
  for (const k of ['enabled', 'frames', 'cols', 'cellWidth', 'maxSeconds', 'maxBytes', 'asr', 'asrUrl']) {
    assert.ok(k in v, `video 配置缺 ${k}`);
  }
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
