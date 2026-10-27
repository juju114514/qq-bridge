// 长图切片（`media-normalize.js` 的 slice 动作）的契约测试。
//
// 背景：群里问「长图怎么适配」，答案是「别整体等比缩（1080×6000 缩完短边只剩 230px，字全糊），
// 按长边切成几片、每片短边保在 1000 上下」。这个测试把那套做法钉住，防止以后被"优化"回去。
//
// 分两层：
//   · 纯函数（任何机器都跑）：planNormalization 选 slice、planSlices 的片数/重叠/方向
//   · 真切片（有 ffmpeg 才跑）：用一张 1080×6000 的图跑完整 normalizeImageForModel，
//     断言片数、每片短边 ≈1000、每片体积 < 上限、note 里有「第 i/n 片」

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const mod = await import(new URL('../src/media-normalize.js', import.meta.url).href);
const { MEDIA_DEFAULTS, planNormalization, planSlices, normalizeImageForModel, sniffImage } = mod;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

const fakeInfo = (width, height, extra = {}) => ({ width, height, animated: false, format: 'png', alpha: false, frames: 1, ...extra });

// ── 1. 什么时候切片 ───────────────────────────────────────────────────────
check('长宽比 ≥ 2.4 且短边 ≥ 480 才切片（普通图继续走 shrink）', () => {
  const tall = planNormalization(fakeInfo(1080, 6000), 2_000_000, {});
  assert.equal(tall.action, 'slice', '1080×6000 应该切片');
  assert.equal(tall.vertical, true, '纵向长图');

  const normal = planNormalization(fakeInfo(1080, 1440), 2_000_000, {});
  assert.equal(normal.action, 'shrink', '1.33 长宽比不该切片');

  const wide = planNormalization(fakeInfo(4000, 1080), 2_000_000, {});
  assert.equal(wide.action, 'slice', '超宽图同样切片');
  assert.equal(wide.vertical, false, '横向长图');

  const small = planNormalization(fakeInfo(300, 2000), 2_000_000, {});
  assert.equal(small.action, 'shrink', '短边 300 太窄，切片也读不出字，仍走整体缩');

  const gif = planNormalization(fakeInfo(1080, 6000, { animated: true }), 2_000_000, {});
  assert.equal(gif.action, 'animate', '动图优先抽帧，不切片');
});

// ── 2. 切片布局 ───────────────────────────────────────────────────────────
check('planSlices：短边 1000、有重叠、片数 ≤ maxSlices', () => {
  for (const [w, h] of [[1080, 6000], [1440, 12000], [4000, 1080]]) {
    const s = planSlices({ width: w, height: h }, {});
    assert.ok(s.short >= 480 && s.short <= 1600, `短边 ${s.short} 超出范围`);
    assert.ok(s.overlap > 0, '必须有重叠，否则一行字会被切断');
    assert.ok(s.overlap <= 60, '重叠不该超过 60px');
    assert.ok(s.count >= 1 && s.count <= MEDIA_DEFAULTS.maxSlices, `${w}×${h} 切出 ${s.count} 片，超过上限 ${MEDIA_DEFAULTS.maxSlices}`);
    // 片长 × 片数 必须能覆盖整张图（否则底部内容会丢）
    const covered = s.strip + (s.count - 1) * (s.strip - s.overlap);
    assert.ok(covered >= s.total - 1, `切片没覆盖到底部：覆盖 ${covered} < 总长 ${s.total}`);
  }
});

check('planSlices：片数超上限时把片拉长，而不是切出 20 片', () => {
  const s = planSlices({ width: 1000, height: 40000 }, {});
  assert.ok(s.count <= MEDIA_DEFAULTS.maxSlices, `40000 高的图切了 ${s.count} 片`);
  assert.ok(s.strip > 1000 * 1.35, '片长应该被拉长');
});

// ── 3. 真切片（需要 ffmpeg）───────────────────────────────────────────────
function findFfmpeg() {
  for (const exe of [process.env.FFMPEG_PATH, 'ffmpeg', 'D:/QQBot/ffmpeg/bin/ffmpeg.exe', 'C:/ffmpeg/bin/ffmpeg.exe']) {
    if (!exe) continue;
    const r = spawnSync(exe, ['-version'], { stdio: 'ignore', timeout: 15000 });
    if (r.status === 0) return exe;
  }
  return null;
}

const ffmpeg = findFfmpeg();
if (!ffmpeg) {
  console.log('  skip 真切片（没有 ffmpeg）');
} else {
  // 用 ffmpeg 自己造一张 1080×6000 的图（画纯色条带，够验证尺寸与片数）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-slice-'));
  try {
    const src = path.join(tmp, 'tall.png');
    const gen = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=1080x6000', '-frames:v', '1', src], { stdio: 'ignore', timeout: 60000 });
    assert.equal(gen.status, 0, '生成测试图失败');
    const buf = fs.readFileSync(src);
    const out = await normalizeImageForModel(buf, 'image/png', {});
    check('真切片：1080×6000 → 多片，每片短边 ≈1000，说明里带「第 i/n 片」', () => {
      assert.equal(out.ok, true, `normalize 失败：${out.error}`);
      assert.ok(Array.isArray(out.slices) && out.slices.length >= 2, '应该切出多片');
      assert.match(out.note, /已切成 \d+ 片/, 'note 要写清切了几片');
      const count = out.slices.length;
      out.slices.forEach((s, i) => {
        const info = sniffImage(s.buffer);
        assert.ok(info, `第 ${i + 1} 片不是有效图片`);
        // 最后一片是剩下的零头，短边自然会小一些（例如 1000×778）；前面每一片都必须是 1000。
        const shortEdge = Math.min(info.width, info.height);
        if (i < count - 1) assert.equal(shortEdge, 1000, `第 ${i + 1} 片短边应缩放到 1000，实际 ${shortEdge}`);
        else assert.ok(shortEdge > 0 && shortEdge <= 1000, `最后一片短边异常：${shortEdge}`);
        assert.ok(s.buffer.length <= 1024 * 1024, `第 ${i + 1} 片超过单张上限`);
        assert.match(s.note, new RegExp(`第 ${i + 1}/${count} 片`), `第 ${i + 1} 片说明不对：${s.note}`);
      });
      assert.equal(out.buffer, out.slices[0].buffer, 'buffer 应回退为第 1 片（老调用方兼容）');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
