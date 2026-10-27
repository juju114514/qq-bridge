// 媒体归一化：把「QQ 给我们的原始图片」压成「DSH 与模型真能吃下的形状」。
//
// ── 为什么需要这一层（2026-10-18 审计结论，见 docs/audits/AUDIT_2026-10-18_MEDIA_AND_WATERMARK.md）
//
// ① 体积悬崖：DSH 的 MCP 图片入口会用正则校验 base64
//    （dsh-mcp-client 的 CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:…)?$/）。
//    这条正则在长输入上会压爆 V8 的 regexp 回溯栈，实测：
//        base64 ≥ 4,474,880 字符（原始字节 ≥ 3.20 MiB）→ RangeError: Maximum call stack size exceeded
//    而 DSH 把这个异常原样降级成 `[image unavailable: image/gif; Maximum call stack size exceeded; …]`
//    —— 模型只看到一行错误，图一个字节都没进上下文。
//    桥接侧的抓取上限（socialV2.media.maxBytes，默认 8 MiB）远在这条线之上，
//    于是「3.2–8 MiB 的图」就成了「桥接认为合法、DSH 必然拒绝」的死区。
//
// ② 动图变单帧：DSH 的 canPassThroughNormalization() 显式排除 image/gif，
//    一律交给 sharp 归一化，而 sharp 默认只解 page 0 —— 一张 48 帧、4.8 MB 的动图，
//    模型最终只看到「第 1 帧压成的 12 KB 静态 JPEG」，而且上下文里没有任何「这是动图」的提示。
//    模型于是只能瞎猜（实测会话里它连着两次给出的解释都是错的）。
//
// ── 本模块的取舍
//
// · **只动喂给模型的那一份**。收集表情（add_custom_face）必须用原始字节，
//   所以归一化只接在 fetchMediaData / resolveMediaList / sticker-image 这些「给模型看」的出口，
//   不去改 fetchOneBotImage / fetchFaceMedia 的返回值。
// · **动图抽帧拼图**而不是发多张图：一条消息 5 张图 = 5 次 DSH admission + 5 份 token，
//   而 3×2 拼图信息密度更高、只算一张图（实测 4.83 MB / 200 帧 → 92 KB / 269 ms）。
// · **能不动就不动**：小图（≤ maxModelBytes 且长边够小）原样放行，零延迟。
// · **ffmpeg 缺失也不硬塞**：超线又压不动的，宁可回一句「太大，看不了」，也不发注定被 DSH 丢掉
//   的字节（那样模型只会看到一行看不懂的错误）。
//
// 依赖：只用 node 内置 + voice-core 的 resolveFfmpeg（ffmpeg 定位的唯一实现）。
// 子进程一律 `stdio: 'ignore'` + 写文件：受限沙箱里 pipe 会 EPERM（见 voice-core.js 开头的说明）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpeg } from './voice-core.js';

/** 默认值集中一处，bridge.js 只做 config 覆盖（见 modelMediaLimits）。 */
export const MEDIA_DEFAULTS = Object.freeze({
  // 交给 DSH 的单张图片原始字节上限。DSH 的炸栈线是 ≈3.20 MiB，
  // 这里取 1 MiB：留 3 倍余量，顺带把 token 成本压一个数量级（1 MiB 图 ≈ 1.33 MB base64）。
  maxModelBytes: 1024 * 1024,
  // 长边上限：手机直出 4000×3000 缩到 1280 后约 150–250 KB，肉眼描述完全够用。
  maxLongEdge: 1280,
  // 动图抽几帧：6 帧正好 3×2，超过 9 帧拼图会小到看不清单帧。
  gifFrames: 6,
  // 每一格的目标宽度（px）：240 一格，3×2 拼图约 736×492，实测 92 KB。
  gifTile: 240,
  // 单张 ffmpeg 调用的硬超时。实测 200 帧 GIF 拼图 269 ms、4K 重编码 < 1 s，25 s 是兜底。
  timeoutMs: 25000,
  // 长图切片（2026-10-27 新增）：长宽比 ≥ sliceAspectMin 的图**不再整体等比缩**，
  // 而是沿长边切成几片、每片短边保在 sliceShort 上下 —— 整体缩会把 1080×6000 压成
  // 230×1280，字全糊成一团。详见 planSlices()。
  sliceAspectMin: 2.4,
  sliceShort: 1000,
  maxSlices: 6,
  // 视频（2026-10-27 新增）：模型只吃静态图，所以视频要降维成「一张故事板 + 一段转写」。
  // 为什么是拼图而不是散图：9 帧散着给 = 9 张图的 token；拼成一张 3×3 ≈ 1 张图的 token。
  videoFrames: 9,
  videoCols: 3,
  videoCellWidth: 420,
  videoMaxSeconds: 180,
  videoTimeoutMs: 60000
});

/** 硬上限：不管 config 怎么写，都不允许超过 DSH 的实测炸栈线下沿。 */
const HARD_MAX_MODEL_BYTES = Math.floor(3.0 * 1024 * 1024);

// ── 格式探测（纯函数，可单测） ────────────────────────────────────────────

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** GIF 子块链跳过：每个子块首字节是长度，0 结束。返回新游标（越界返回 -1）。 */
function skipGifSubBlocks(buf, pos) {
  let p = pos;
  let guard = 0;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) return p;
    p += size;
    if (++guard > 1_000_000) return -1;
  }
  return -1;
}

/**
 * 解析 GIF 的帧数与总时长（以及是否有透明帧）。
 *
 * 为什么不直接问 ffprobe：a) ffmpeg 可能没装，而「这是动图，N 帧」这句话就算没 ffmpeg
 * 也要能告诉模型；b) 每次看图都 spawn 一次 ffprobe 是白花的时间（这里纯内存解析）。
 * GIF 的块结构很实在：0x2C = 图像描述符（一帧），0x21 0xF9 = 图形控制扩展（带 delay）。
 */
function parseGif(buf) {
  if (buf.length < 13) return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  let pos = 13;
  if (packed & 0x80) pos += 3 * (2 << (packed & 0x07)); // 全局颜色表
  let frames = 0;
  let durationCs = 0;
  let alpha = false;
  let delayCs = 0;
  let guard = 0;
  while (pos >= 0 && pos < buf.length) {
    if (++guard > 5_000_000) break;
    const block = buf[pos];
    pos += 1;
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      if (pos >= buf.length) break;
      const label = buf[pos];
      pos += 1;
      if (label === 0xf9 && pos + 4 <= buf.length) {
        // 块长(1) 打包位(1) delay(2) 透明色索引(1) 终结符(1)
        const size = buf[pos];
        if (size >= 4 && pos + 4 < buf.length) {
          const gcePacked = buf[pos + 1];
          delayCs = buf.readUInt16LE(pos + 2);
          if (gcePacked & 0x01) alpha = true;
        }
      }
      pos = skipGifSubBlocks(buf, pos);
      continue;
    }
    if (block === 0x2c) {
      if (pos + 9 > buf.length) break;
      const descPacked = buf[pos + 8];
      pos += 9;
      if (descPacked & 0x80) pos += 3 * (2 << (descPacked & 0x07)); // 局部颜色表
      pos += 1; // LZW 最小码长
      pos = skipGifSubBlocks(buf, pos);
      frames += 1;
      durationCs += delayCs || 0;
      delayCs = 0;
      continue;
    }
    break; // 解析不了就别硬猜
  }
  return {
    width,
    height,
    frames: Math.max(1, frames),
    durationMs: durationCs > 0 ? durationCs * 10 : 0,
    alpha
  };
}

/** WebP：解析尺寸，并识别动图（ANIM 块 / ANMF 帧块）。 */
function parseWebp(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('ascii', 12, 16);
  let width = 0;
  let height = 0;
  if (fourcc === 'VP8X') {
    width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
    height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
  } else if (fourcc === 'VP8L') {
    const b = [buf[21], buf[22], buf[23], buf[24]];
    width = 1 + (((b[1] & 0x3f) << 8) | b[0]);
    height = 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
  } else if (fourcc === 'VP8 ') {
    width = buf.readUInt16LE(26) & 0x3fff;
    height = buf.readUInt16LE(28) & 0x3fff;
  } else {
    return null;
  }
  // 动图：RIFF 里出现 ANIM（动画头）与若干个 ANMF（帧）。只数块头，不解析负载。
  let frames = 0;
  let pos = 12;
  let guard = 0;
  while (pos + 8 <= buf.length && ++guard < 1_000_000) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'ANMF') frames += 1;
    pos += 8 + size + (size & 1);
  }
  const alpha = fourcc === 'VP8X' ? (buf[20] & 0x10) !== 0 : true;
  return { width, height, frames: Math.max(1, frames), durationMs: 0, alpha };
}

function parsePng(buf) {
  if (buf.length < 26) return null;
  const colorType = buf[25];
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    frames: 1,
    durationMs: 0,
    alpha: colorType === 4 || colorType === 6
  };
}

function parseJpeg(buf) {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const len = buf.readUInt16BE(offset + 2);
    if (len < 2) return null;
    // SOF0–SOF15（排除 DHT C4 / JPG C8 / DAC CC）
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), frames: 1, durationMs: 0, alpha: false };
    }
    offset += 2 + len;
  }
  return null;
}

/**
 * 从字节里认出格式/尺寸/帧数。
 *
 * @returns null（认不出）或
 *   { format:'gif'|'png'|'jpeg'|'webp', width, height, frames, durationMs, animated, alpha }
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  let format = null;
  let parsed = null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    format = 'png'; parsed = parsePng(buf);
  } else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    format = 'jpeg'; parsed = parseJpeg(buf);
  } else if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
    format = 'gif'; parsed = parseGif(buf);
  } else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    format = 'webp'; parsed = parseWebp(buf);
  }
  if (!parsed || !parsed.width || !parsed.height) return null;
  return {
    format,
    width: parsed.width,
    height: parsed.height,
    frames: Math.max(1, parsed.frames || 1),
    durationMs: parsed.durationMs || 0,
    animated: (parsed.frames || 1) > 1,
    alpha: !!parsed.alpha
  };
}

// ── 决策（纯函数，可单测） ────────────────────────────────────────────────

/**
 * 要不要动这张图？返回 null = 原样放行。
 *
 * @param info sniffImage() 的结果（null 表示认不出 → 一律放行，交给下游）
 * @param bytes 原始字节数
 * @param limits 归一化上限
 */
export function planNormalization(info, bytes, limits = {}) {
  const maxBytes = clampInt(limits.maxModelBytes, 64 * 1024, HARD_MAX_MODEL_BYTES, MEDIA_DEFAULTS.maxModelBytes);
  const maxLongEdge = clampInt(limits.maxLongEdge, 256, 2048, MEDIA_DEFAULTS.maxLongEdge);
  if (!info) {
    // 认不出的格式：能放就放（下游 mimeFromBuffer 会兜底），太大就拒绝——绝不硬塞。
    return bytes > maxBytes ? { action: 'reject', reason: `未知图片格式且 ${bytes} 字节超过上限` } : null;
  }
  if (info.animated) {
    return { action: 'animate', maxBytes, maxLongEdge };
  }
  const longEdge = Math.max(info.width, info.height);
  if (bytes <= maxBytes && longEdge <= maxLongEdge) return null;
  const shortEdge = Math.min(info.width, info.height);
  const aspect = shortEdge > 0 ? longEdge / shortEdge : 1;
  const sliceAspectMin = Number(limits.sliceAspectMin) > 0 ? Number(limits.sliceAspectMin) : MEDIA_DEFAULTS.sliceAspectMin;
  // 长图：整体等比缩会把长边压到 maxLongEdge，短边跟着塌到只剩一两百像素，字全糊。
  // 这种情况改成「沿长边切片」，每片短边保在 sliceShort 上下（见 planSlices）。
  if (aspect >= sliceAspectMin && shortEdge >= 480) {
    return { action: 'slice', maxBytes, maxLongEdge, bytes, longEdge, shortEdge, aspect, vertical: info.height > info.width };
  }
  return { action: 'shrink', maxBytes, maxLongEdge, bytes, longEdge };
}

/**
 * 长图切片布局（纯函数，不碰 ffmpeg，便于单测）。
 *
 * 场景：截图/聊天记录长图常常是 1080×4000、1440×12000 这种。整体等比缩到 longEdge=1280 之后
 * 短边只剩 100~300 像素，文字彻底看不清 —— 模型的结论就是"图太小看不清"。
 *
 * 做法：沿**长边**切，每片短边保持在 sliceShort（默认 1000，接近微信/QQ 截图的原始宽度），
 * 片高 ≈ 短边 × 1.35（略高于宽，保证一屏信息量又不会太长），相邻片之间留 6% 重叠，
 * 避免一行字正好被切在缝里。
 *
 * @param {{width:number,height:number}} info sniffImage() 的结果
 * @param {object} limits { sliceShort, maxSlices }
 * @returns {{vertical:boolean, short:number, strip:number, overlap:number, count:number, total:number}}
 */
export function planSlices(info, limits = {}) {
  const width = Math.max(1, Number(info?.width) || 1);
  const height = Math.max(1, Number(info?.height) || 1);
  const vertical = height >= width;
  const total = vertical ? height : width;
  const shortSide = vertical ? width : height;
  const short = clampInt(limits.sliceShort, 480, 1600, MEDIA_DEFAULTS.sliceShort);
  const maxSlices = clampInt(limits.maxSlices, 2, 10, MEDIA_DEFAULTS.maxSlices);
  // 片长：先按"短边 × 1.35"取，片数超过上限就加长（宁可每片高一点，也不切出 20 片）。
  let strip = Math.max(240, Math.round(short * 1.35));
  strip = Math.max(strip, Math.ceil(total / maxSlices));
  let overlap = Math.min(60, Math.max(0, Math.round(strip * 0.06)));
  let step = Math.max(1, strip - overlap);
  let count = Math.max(1, Math.ceil((total - overlap) / step));
  // 片数超过上限时把片拉长（而不是切出 7~10 片）：多一片就多一张图的 token 成本。
  if (count > maxSlices) {
    step = Math.ceil((total - overlap) / maxSlices);
    strip = step + overlap;
    count = Math.max(1, Math.ceil((total - overlap) / step));
  }
  return { vertical, short, strip, overlap, count, total, shortSide };
}

/**
 * 视频「故事板」布局（纯函数，便于单测）。
 *
 * 模型只接受图片，所以视频必须降维：均匀抽 N 帧拼成 cols×rows 网格，每格左上角烧时间戳。
 * 为什么拼图：9 张散图 = 9 张图的 token；拼成一张 3×3 ≈ 1 张图。
 *
 * @param {{durationSec:number, width?:number, height?:number}} info
 * @param {{videoFrames?:number, videoCols?:number, videoCellWidth?:number, maxLongEdge?:number, videoMaxSeconds?:number}} limits
 * @returns {{cols:number, rows:number, count:number, cellW:number, cellH:number, durationSec:number,
 *            fps:number, times:number[], truncated:boolean}}
 */
export function planVideoFrames(info, limits = {}) {
  const rawDur = Number(info?.durationSec);
  const durationSec = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 0;
  const maxSeconds = clampInt(limits.videoMaxSeconds, 5, 3600, MEDIA_DEFAULTS.videoMaxSeconds);
  const shownSec = Math.min(durationSec || maxSeconds, maxSeconds);
  const maxFrames = clampInt(limits.videoFrames, 1, 25, MEDIA_DEFAULTS.videoFrames);
  const cols = clampInt(limits.videoCols, 1, 5, MEDIA_DEFAULTS.videoCols);
  const rows = Math.max(1, Math.ceil(maxFrames / cols));
  const count = Math.max(1, Math.min(maxFrames, Math.ceil(shownSec) || 1));
  // 每格宽度：保证 cols×cellW + 间距 ≤ maxLongEdge，否则整张会被二次缩小（字就糊了）
  const maxLongEdge = clampInt(limits.maxLongEdge, 256, 2048, MEDIA_DEFAULTS.maxLongEdge);
  const pad = 4;
  const fitW = Math.floor((maxLongEdge - pad * (cols + 1)) / cols);
  const wantW = clampInt(limits.videoCellWidth, 160, 1024, MEDIA_DEFAULTS.videoCellWidth);
  const cellW = Math.max(120, Math.min(wantW, fitW));
  const srcW = Number(info?.width) > 0 ? Number(info.width) : 0;
  const srcH = Number(info?.height) > 0 ? Number(info.height) : 0;
  const ratio = srcW > 0 && srcH > 0 ? srcH / srcW : 9 / 16;
  const cellH = Math.max(2, Math.round((cellW * ratio) / 2) * 2);
  // 采样点：均匀分布，取每段的中点（避免第一帧是黑屏/片头）
  const step = shownSec / count;
  const times = Array.from({ length: count }, (_, i) => Number((step * i + step / 2).toFixed(2)));
  return {
    cols,
    rows,
    count,
    cellW,
    cellH,
    durationSec,
    shownSec,
    fps: count / Math.max(0.1, shownSec),
    times,
    truncated: durationSec > maxSeconds
  };
}

/**
 * 读视频元数据（时长 / 尺寸 / 有没有音轨）。
 *
 * 为什么必须探：抽帧要按**真实时长**均匀取点。拿不到时长就按上限 180s 取 9 帧的话，
 * 10 秒的短视频会取到 8 个不存在的时刻 —— 故事板会缺格甚至全黑。
 * 拿不到 ffprobe 时返回 ok:false，调用方应退化为"只给第一帧/放弃视频"。
 */
export async function probeVideo(file, opts = {}) {
  const dir = path.dirname(String(resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null })));
  const candidates = [opts.ffprobePath, path.join(dir, 'ffprobe.exe'), path.join(dir, 'ffprobe'), 'ffprobe']
    .filter(Boolean);
  for (const exe of candidates) {
    const outFile = path.join(os.tmpdir(), `qqb-probe-${process.pid}-${Date.now()}.json`);
    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(exe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', String(file)],
          { windowsHide: true, stdio: ['ignore', fs.openSync(outFile, 'w'), 'ignore'] });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message ?? error) });
        return;
      }
      let settled = false;
      const settle = (o) => { if (!settled) { settled = true; clearTimeout(timer); resolve(o); } };
      const timer = setTimeout(() => { try { child.kill(); } catch {} ; settle({ ok: false, error: 'ffprobe 超时' }); }, 15000);
      child.on('error', (error) => settle({ ok: false, error: String(error?.message ?? error) }));
      child.on('close', (code) => settle({ ok: code === 0, error: code === 0 ? '' : `ffprobe 退出码 ${code}` }));
    });
    const raw = readIfExists(outFile);
    try { fs.unlinkSync(outFile); } catch {}
    if (!result.ok || !raw) continue;
    try {
      const info = JSON.parse(raw.toString('utf8'));
      const video = (info.streams ?? []).find((s) => s.codec_type === 'video');
      if (!video) continue;
      return {
        ok: true,
        durationSec: Number(info.format?.duration) || Number(video.duration) || 0,
        width: Number(video.width) || 0,
        height: Number(video.height) || 0,
        hasAudio: (info.streams ?? []).some((s) => s.codec_type === 'audio')
      };
    } catch { continue; }
  }
  return { ok: false, error: '读不到视频元数据（没装 ffprobe，或文件不是视频）' };
}

/**
 * 把视频降维成一张「故事板」JPEG（cols×rows，每格烧时间戳）。
 *
 * @param {string} file 本地视频路径
 * @param {{durationSec?:number, width?:number, height?:number, videoFrames?:number, videoCols?:number,
 *          videoCellWidth?:number, maxLongEdge?:number, maxBytes?:number, ffmpegPath?:string,
 *          timeoutMs?:number, tmpDir?:string, label?:string}} opts
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, layout?:object, error?:string}>}
 */
export async function normalizeVideoForModel(file, opts = {}) {
  const layout = planVideoFrames({ durationSec: opts.durationSec, width: opts.width, height: opts.height }, opts);
  const ffmpeg = resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null });
  const dir = makeTempWorkspace(opts.tmpDir);
  try {
    // drawtext 烧时间戳：模型能对上"第几秒发生了什么"，比单纯靠格子顺序可靠
    const font = 'C\\:/Windows/Fonts/consola.ttf';
    const label = "drawtext=fontfile='" + font + "':text='%{pts\\:hms}':x=6:y=6:fontsize=18"
      + ':fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=4';
    const vf = `fps=${Number(layout.fps.toFixed(6))},scale=${layout.cellW}:-2,${label},`
      + `tile=${layout.cols}x${layout.rows}:padding=4:margin=4:color=black`;
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outFile = path.join(dir, `board-${attempt}.jpg`);
      const args = ['-v', 'error', '-y', '-i', file, '-vf', vf, '-frames:v', '1', '-q:v', String(3 + attempt * 2), outFile];
      const run = await runFfmpeg(ffmpeg, args, { timeoutMs: opts.timeoutMs ?? MEDIA_DEFAULTS.videoTimeoutMs });
      if (!run.ok) { lastError = run.error; break; }
      const buf = readIfExists(outFile);
      if (!buf) { lastError = '故事板输出为空'; continue; }
      const maxBytes = clampInt(opts.maxBytes, 64 * 1024, HARD_MAX_MODEL_BYTES, MEDIA_DEFAULTS.maxModelBytes);
      if (buf.length <= maxBytes) {
        const label2 = `视频 ${layout.shownSec.toFixed(0)}s 抽 ${layout.count} 帧拼成 ${layout.cols}×${layout.rows} 故事板`
          + `（每格左上角是时间戳，行优先 左上→右下）`;
        return { ok: true, buffer: buf, mimeType: 'image/jpeg', layout, note: label2 };
      }
      lastError = '故事板压缩后仍超限';
    }
    return { ok: false, error: `视频故事板生成失败（${lastError}）`, layout };
  } finally {
    cleanupWorkspace(dir);
  }
}

/** 从视频里抽 16k 单声道音轨（喂 ASR）。返回临时文件路径，调用方负责删。 */
export async function extractVideoAudio(file, opts = {}) {
  const ffmpeg = resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null });
  const dir = makeTempWorkspace(opts.tmpDir);
  const out = path.join(dir, 'audio16k.wav');
  const maxSeconds = clampInt(opts.videoMaxSeconds, 5, 3600, MEDIA_DEFAULTS.videoMaxSeconds);
  const run = await runFfmpeg(ffmpeg, [
    '-v', 'error', '-y', '-i', file, '-t', String(maxSeconds),
    '-vn', '-ar', '16000', '-ac', '1', out
  ], { timeoutMs: opts.timeoutMs ?? MEDIA_DEFAULTS.videoTimeoutMs });
  if (!run.ok || !readIfExists(out)) {
    cleanupWorkspace(dir);
    return { ok: false, error: run.ok ? '音轨为空（视频可能没有声音）' : run.error };
  }
  return { ok: true, file: out, cleanup: () => cleanupWorkspace(dir) };
}

/** 动图拼图布局：帧数 → { cols, rows, fps, sampleFrames }。纯函数。 */
export function planAnimation(info, limits = {}) {
  const wanted = clampInt(limits.gifFrames, 2, 12, MEDIA_DEFAULTS.gifFrames);
  const frames = Math.max(1, info?.frames || 1);
  // 帧比想要的多才有意思抽帧；帧本来就少就全用上（不重复填充没信息量的格子）。
  const sample = Math.min(wanted, frames);
  // 布局偏好：6→3×2、9→3×3、8→4×2（都填满），其余按接近正方形算。
  const layout = { 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2], 9: [3, 3], 10: [5, 2], 11: [4, 3], 12: [4, 3] }[sample]
    ?? [Math.ceil(Math.sqrt(sample)), Math.ceil(sample / Math.ceil(Math.sqrt(sample)))];
  const [cols, rows] = layout;
  // fps 必须让 ffmpeg 恰好产出 sample 帧；时长未知时按每帧 100 ms 估（QQ 表情的常见默认）。
  const durationMs = info?.durationMs > 0 ? info.durationMs : frames * 100;
  const seconds = Math.max(0.05, durationMs / 1000);
  const fps = Math.min(30, Math.max(0.05, Number((sample / seconds).toFixed(4))));
  return { cols, rows, fps, sampleFrames: sample, totalFrames: frames, durationMs };
}

// ── ffmpeg 调用 ──────────────────────────────────────────────────────────

/**
 * 跑一次 ffmpeg：输入/输出都走文件，stdio 全 ignore。
 *
 * 为什么不用管道：受限沙箱里 `spawn` + stdio:'pipe' 会直接 EPERM（voice-core.js 开头有同样记录）。
 * 代价是拿不到 ffmpeg 的 stderr —— 所以调用方只报「退出码 + 动作名」，不假装能诊断具体原因。
 */
function runFfmpeg(ffmpeg, args, { timeoutMs = MEDIA_DEFAULTS.timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: `ffmpeg 启动失败：${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      settle({ ok: false, error: `ffmpeg 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.on('error', (error) => settle({
      ok: false,
      error: error?.code === 'ENOENT'
        ? '找不到 ffmpeg（设置 FFMPEG_PATH 或 config.json 的 socialV2.voice.ffmpegPath）'
        : `ffmpeg 不可用：${error?.message ?? error}`
    }));
    child.on('close', (code) => settle(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg 退出码 ${code}` }));
  });
}

function makeTempWorkspace(tmpDir) {
  const base = tmpDir ? path.resolve(tmpDir) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'qqb-media-'));
}

function cleanupWorkspace(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** 按扩展名挑输出容器：有 alpha 用 PNG（保透明），否则 JPEG（体积小得多）。 */
function pickOutputExt(info) {
  return info?.alpha ? '.png' : '.jpg';
}

function readIfExists(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return null;
    return fs.readFileSync(file);
  } catch { return null; }
}

// ── 主入口 ──────────────────────────────────────────────────────────────

/**
 * 把一张图整理成「可以安全交给 DSH / 模型」的形态。
 *
 * @param buf       原始字节
 * @param mimeType  调用方已知的 MIME（可能与实际不符，以字节探测为准）
 * @param opts      { maxModelBytes, maxLongEdge, gifFrames, gifTile, enabled, ffmpegPath, tmpDir, label, timeoutMs }
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, error?:string, skipped?:boolean}>}
 *   ok=false 只在「超大且压不动」时出现；调用方应把它变成一句可读的失败原因，而不是发空图。
 */
export async function normalizeImageForModel(buf, mimeType, opts = {}) {
  const bytes = Buffer.isBuffer(buf) ? buf.length : 0;
  if (!bytes) return { ok: false, error: '图片字节为空' };
  if (opts.enabled === false) return { ok: true, buffer: buf, mimeType, note: '' };

  const info = sniffImage(buf);
  const plan = planNormalization(info, bytes, opts);
  if (!plan) {
    // 原样放行：这是绝大多数情况（小图），零额外延迟。
    return { ok: true, buffer: buf, mimeType: mimeType || (info ? `image/${info.format === 'jpeg' ? 'jpeg' : info.format}` : 'image/jpeg'), note: '' };
  }
  if (plan.action === 'reject') {
    return { ok: false, error: plan.reason, skipped: true };
  }

  const ffmpeg = resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null });
  const maxBytes = plan.maxBytes;
  const maxLongEdge = plan.maxLongEdge;

  const dir = makeTempWorkspace(opts.tmpDir);
  try {
    const inExt = info.format === 'jpeg' ? '.jpg' : `.${info.format}`;
    const inFile = path.join(dir, `in${inExt}`);
    fs.writeFileSync(inFile, buf);

    if (plan.action === 'animate') {
      const layout = planAnimation(info, opts);
      const tileWidth = clampInt(opts.gifTile, 64, 400, MEDIA_DEFAULTS.gifTile);
      const outFile = path.join(dir, 'strip.jpg');
      const vf = `fps=${layout.fps},scale=${tileWidth}:-1:flags=lanczos,` +
        `tile=${layout.cols}x${layout.rows}:padding=4:margin=4:color=white`;
      const run = await runFfmpeg(ffmpeg, [
        '-v', 'error', '-y', '-i', inFile,
        '-filter_complex', `[0:v]${vf}[out]`, '-map', '[out]',
        '-frames:v', '1', '-q:v', '4', outFile
      ], { timeoutMs: opts.timeoutMs });
      const out = run.ok ? readIfExists(outFile) : null;
      if (out && out.length <= maxBytes) {
        const seconds = (layout.durationMs / 1000).toFixed(1);
        return {
          ok: true,
          buffer: out,
          mimeType: 'image/jpeg',
          // 这段文字会原样出现在工具结果里（外面还会再包一层括号），所以**不要用嵌套括号**。
          note: `动图 ${layout.totalFrames} 帧/${seconds}s，已抽 ${layout.sampleFrames} 帧拼成 ${layout.cols}×${layout.rows} 网格，行优先 左上→右下；原图 ${(bytes / 1024 / 1024).toFixed(2)}MB`
        };
      }
      // 拼图失败（没 ffmpeg / 超时 / 还是太大）：退化到「能看多少算多少」。
      if (bytes <= maxBytes) {
        return {
          ok: true,
          buffer: buf,
          mimeType: mimeType || 'image/gif',
          note: `动图 ${layout.totalFrames} 帧（抽帧拼图失败：${run.ok ? '输出仍超限' : run.error}，只提供首帧）`
        };
      }
      return { ok: false, error: `动图 ${(bytes / 1024 / 1024).toFixed(2)}MB 无法压缩（${run.ok ? '输出仍超限' : run.error}）` };
    }

    // action === 'slice'：长图沿长边切片。
    // 为什么不整体缩：1080×6000 缩到长边 1280 后短边只剩 230 像素，文字彻底糊掉。
    if (plan.action === 'slice') {
      const layout = planSlices(info, opts);
      const slices = [];
      let lastError = '';
      for (let i = 0; i < layout.count; i += 1) {
        const start = Math.max(0, i * (layout.strip - layout.overlap));
        const remain = layout.total - start;
        if (remain <= 0) break;
        const len = Math.min(layout.strip, remain);
        // 短边缩/放到 layout.short（保留原分辨率信息，宽度统一便于模型对位）
        const crop = layout.vertical
          ? `crop=${info.width}:${len}:0:${start},scale=${layout.short}:-2:flags=lanczos`
          : `crop=${len}:${info.height}:${start}:0,scale=-2:${layout.short}:flags=lanczos`;
        let saved = null;
        for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
          const outFile = path.join(dir, `slice-${i}.jpg`);
          const args = ['-v', 'error', '-y', '-i', inFile, '-vf', crop];
          args.push('-q:v', String(3 + attempt * 3), outFile);
          const run = await runFfmpeg(ffmpeg, args, { timeoutMs: opts.timeoutMs });
          if (!run.ok) { lastError = run.error; break; }
          const out = readIfExists(outFile);
          if (out && out.length <= maxBytes) saved = out;
          else lastError = out ? '切片后仍超限' : '切片输出为空';
        }
        if (!saved) break;
        const from = start + 1;
        const to = start + len;
        slices.push({
          buffer: saved,
          mimeType: 'image/jpeg',
          note: `第 ${i + 1}/${layout.count} 片（${layout.vertical ? '纵向' : '横向'}，原文 ${from}-${to}px，短边 ${layout.short}）`
        });
      }
      if (slices.length >= 1) {
        const totalKb = Math.round(slices.reduce((sum, s) => sum + s.buffer.length, 0) / 1024);
        return {
          ok: true,
          buffer: slices[0].buffer,
          mimeType: 'image/jpeg',
          slices,
          note: `长图 ${info.width}×${info.height}（长宽比 ${plan.aspect.toFixed(1)}）已切成 ${slices.length} 片，每片短边 ${layout.short}、相邻重叠 ${layout.overlap}px，共 ${totalKb}KB；按顺序看，拼起来才是完整内容`
        };
      }
      // 切不了（没 ffmpeg / 超时）：退回整体缩，至少给个概览。
      lastError = lastError || '切片失败';
      return {
        ok: bytes <= maxBytes,
        buffer: bytes <= maxBytes ? buf : undefined,
        mimeType: mimeType || (info.format === 'jpeg' ? 'image/jpeg' : `image/${info.format}`),
        note: `长图切片失败（${lastError}），只能给原图概览，细节可能看不清`,
        ...(bytes <= maxBytes ? {} : { error: `长图 ${(bytes / 1024 / 1024).toFixed(2)}MB 切不开也压不下（${lastError}）` })
      };
    }

    // action === 'shrink'：静态图降采样 + 重编码，最多试三轮（逐步缩小尺寸/降质量）。
    const outExt = pickOutputExt(info);
    let edge = maxLongEdge;
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const scale = Math.min(1, edge / Math.max(info.width, info.height));
      const width = Math.max(2, Math.round(info.width * scale) & ~1);
      const height = Math.max(2, Math.round(info.height * scale) & ~1);
      const outFile = path.join(dir, `out-${attempt}${outExt}`);
      const args = ['-v', 'error', '-y', '-i', inFile, '-vf', `scale=${width}:${height}:flags=lanczos`];
      if (outExt === '.jpg') args.push('-q:v', String(3 + attempt * 3));
      args.push(outFile);
      const run = await runFfmpeg(ffmpeg, args, { timeoutMs: opts.timeoutMs });
      if (!run.ok) { lastError = run.error; }
      else {
        const out = readIfExists(outFile);
        if (out && out.length <= maxBytes) {
          return {
            ok: true,
            buffer: out,
            mimeType: outExt === '.jpg' ? 'image/jpeg' : 'image/png',
            note: `原图 ${info.width}×${info.height} ${(bytes / 1024).toFixed(0)}KB → ${width}×${height} ${(out.length / 1024).toFixed(0)}KB`
          };
        }
        lastError = '压缩后仍超限';
      }
      edge = Math.max(320, Math.round(edge * 0.7));
    }
    // 压不动：小图照发，大图明确拒绝（绝不发注定被 DSH 丢掉的东西）。
    if (bytes <= maxBytes) return { ok: true, buffer: buf, mimeType, note: `压缩失败（${lastError}），按原图提供` };
    return { ok: false, error: `${(bytes / 1024 / 1024).toFixed(2)}MB 压不到 ${(maxBytes / 1024).toFixed(0)}KB 以内（${lastError}）` };
  } finally {
    cleanupWorkspace(dir);
  }
}

/** 供日志/提示用的一句话摘要（不含 base64）。 */
export function describeImage(buf) {
  const info = sniffImage(buf);
  if (!info) return `未知格式 ${buf?.length ?? 0}B`;
  const parts = [`${info.format} ${info.width}×${info.height}`, `${(buf.length / 1024).toFixed(0)}KB`];
  if (info.animated) parts.push(`动图 ${info.frames} 帧${info.durationMs ? `/${(info.durationMs / 1000).toFixed(1)}s` : ''}`);
  return parts.join(' ');
}
