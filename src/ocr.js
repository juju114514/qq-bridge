// Windows 自带 OCR（Windows.Media.Ocr）的 Node 封装。
//
// 为什么需要：
//   一张 1080×6000 的聊天记录长截图，走"切片给模型看"要 5 张图（~1.7MB，约 1.5 万 token）；
//   而如果只是想知道"写了什么"，OCR 出文字只要几百 token。群里的结论也是这个：
//   「要是只想知道写了什么，先 OCR 出文字给我更省；看图才需要切片，两套一起用也行」。
//
// 设计约束（照抄项目里踩过的坑）：
//   · **进程间通信只走文件**：受限沙箱下 `spawn` + stdio:'pipe' 会 EPERM（见 voice-core.js /
//     media-normalize.js 的注释）。这里给 powershell 的 stdio 全部 ignore，结果写临时 JSON 再读。
//   · **失败要能降级**：没装语言包 / 非 Windows / 超时，一律返回 {ok:false, reason}，
//     调用方据此退回切片，绝不抛异常打断整条消息。
//   · **可用性缓存**：探测一次就记住（同一进程内不会装/卸语言包）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'scripts', 'ocr-image.ps1');
const DEFAULT_TIMEOUT_MS = 30000;

let availableCache = null;

/**
 * 抹掉 Windows OCR 在汉字之间插的空格。
 *
 * 实测：`这是第 1 行测试文本` 会被识别成 `这 是 第 1 行 测 试 文 本`。
 * 不处理的话，同一段文字 token 数会翻 2~3 倍——正好抵消了"用 OCR 省 token"的初衷。
 * 规则：**只有当空格两侧至少一侧是中日韩文字/全角标点时**才删；`第 1 行` 这种数字两侧的空格保留。
 */
export function normalizeOcrText(raw) {
  const text = String(raw ?? '');
  if (!text) return '';
  const cjk = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
  // 只把**全角**标点算进"中文语境"：半角 : ; , . 后面的空格是有意义的分隔
  // （例如 `krystal: 这是…`），删掉会把英文昵称和中文黏在一起。
  const wide = '\\u3000-\\u303f\\uff01-\\uff65'; // 全角空格/标点/全角字母数字
  const cjkSet = `[${cjk}${wide}]`;
  return text
    .split('\n')
    .map((line) => line
      // 汉字之间的空格
      .replace(new RegExp(`(${cjkSet})\\s+(?=${cjkSet})`, 'g'), '$1')
      // 汉字紧邻全角标点
      .replace(new RegExp(`(${cjkSet})\\s+(?=[\\u3000-\\u303f\\uff01-\\uff65])`, 'g'), '$1')
      .replace(new RegExp(`([\\u3000-\\u303f\\uff01-\\uff65])\\s+(?=${cjkSet})`, 'g'), '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** OCR 是否可能可用（Windows + 有脚本 + 有 PowerShell）。只探测一次。 */
export function ocrAvailable() {
  if (availableCache !== null) return availableCache;
  if (process.platform !== 'win32') { availableCache = false; return false; }
  availableCache = fs.existsSync(SCRIPT);
  return availableCache;
}

function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, reason: 'spawn-failed', error: String(error?.message ?? error) });
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
      try { child.kill(); } catch { /* 已退出 */ }
      settle({ ok: false, reason: 'timeout', error: `OCR 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.on('error', (error) => settle({ ok: false, reason: 'spawn-failed', error: String(error?.message ?? error) }));
    child.on('close', (code) => settle({ ok: true, code }));
  });
}

/**
 * 识别一张图片里的文字。
 * @param {Buffer} buffer 图片字节（PNG/JPEG/BMP/TIFF）
 * @param {{lang?:string, timeoutMs?:number, mimeType?:string}} opts
 * @returns {Promise<{ok:boolean, text?:string, lines?:Array, lang?:string, ms?:number,
 *                    width?:number, height?:number, reason?:string, error?:string}>}
 */
export async function ocrImage(buffer, opts = {}) {
  if (!ocrAvailable()) return { ok: false, reason: 'unavailable', error: '当前环境没有 Windows OCR（非 Windows 或缺少 scripts/ocr-image.ps1）' };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, reason: 'bad-image', error: '图片字节为空' };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-ocr-'));
  const ext = String(opts.mimeType ?? '').includes('png') ? '.png' : '.jpg';
  const imagePath = path.join(dir, `in${ext}`);
  const outPath = path.join(dir, 'result.json');
  try {
    fs.writeFileSync(imagePath, buffer);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Image', imagePath, '-Out', outPath];
    if (opts.lang) args.push('-Lang', String(opts.lang));
    const run = await runPowerShell(args, Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS);
    if (!run.ok) return { ok: false, reason: run.reason, error: run.error };

    let json = null;
    try { json = JSON.parse(fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 下面统一报 */ }
    if (!json) return { ok: false, reason: 'no-result', error: `OCR 没有产出结果（powershell 退出码 ${run.code}）` };
    if (!json.ok) return { ok: false, reason: json.reason || 'ocr-failed', error: json.error || 'OCR 失败' };

    const lines = Array.isArray(json.lines) ? json.lines : [];
    const text = normalizeOcrText(lines.length ? lines.map((l) => l?.text ?? '').join('\n') : json.text);
    return {
      ok: true,
      text,
      lines,
      lang: json.lang ?? '',
      ms: Number(json.ms) || 0,
      width: Number(json.width) || 0,
      height: Number(json.height) || 0
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉就等系统清 */ }
  }
}
