// 平台能力探测（0.5.43）
//
// 为什么需要：桥接原来默认"我在 Windows 上，PowerShell / 计划任务 / Edge / ffmpeg 都有"。
// 一旦搬到 Linux 或 Android（Termux），这些能力**部分或全部不存在**。
// 2026-11-02 在 Android 模拟器上实测：桥接能起来，但点歌、OCR、长文转图、网关启停都不可用 ——
// 用户点了才报错，很难受。
//
// 这个模块把「本机有什么、没什么」提前算出来，供控制台显示与路由降级使用。
import fs from 'node:fs';
import path from 'node:path';

const isWin = (platform) => platform === 'win32';
const isAndroid = (platform, env) => Boolean(env.ANDROID_ROOT) || platform === 'android';

/** 在 PATH 里找一个可执行文件（跨平台，不依赖 which/where） */
function findInPath(name, { env = process.env, fsImpl = fs, platform = process.platform } = {}) {
  const exts = isWin(platform) ? ['', '.exe', '.cmd', '.bat'] : [''];
  const sep = isWin(platform) ? ';' : ':';
  const dirs = String(env.PATH || '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fsImpl.existsSync(p)) return p; } catch { /* ignore */ }
    }
  }
  return '';
}

/**
 * @param {{platform?:string, env?:object, fsImpl?:object, probe?:Function}} [opts]
 * @returns {{platform:string, android:boolean, windows:boolean, features:object, missing:string[]}}
 */
export function detectCapabilities(opts = {}) {
  const { platform = process.platform, env = process.env, fsImpl = fs } = opts;
  const find = opts.findImpl || ((n) => findInPath(n, { env, fsImpl, platform }));
  const windows = isWin(platform);
  const android = isAndroid(platform, env);

  const ffmpeg = env.FFMPEG_PATH || find('ffmpeg');
  const powershell = windows ? (find('powershell') || find('pwsh')) : (env.QQBOT_HAS_POWERSHELL ? 'declared' : '');

  const features = {
    // 语音/点歌：需要 ffmpeg 截取
    ffmpeg: Boolean(ffmpeg),
    // 点歌脚本、OCR、抖音 cookie 工具都靠 PowerShell
    powershell: Boolean(powershell),
    // 网关启停（schtasks / 进程清理）
    scheduledTask: windows,
    // 长文本转图：Edge/Chrome headless + CDP
    textToImage: windows && Boolean(env.QQBOT_T2I_DISABLED ? '' : 'maybe'),
    // 本机 OCR（tesseract）
    ocr: Boolean(find('tesseract')),
    // 计划任务守护（watchdog）
    watchdog: windows
  };

  const labels = {
    ffmpeg: '语音/点歌（需要 ffmpeg）',
    powershell: '点歌脚本、OCR、抖音工具（需要 PowerShell）',
    scheduledTask: '网关一键启停（需要计划任务）',
    textToImage: '长文本转图（需要 Edge headless）',
    ocr: '本地 OCR（需要 tesseract）',
    watchdog: '守护进程（需要计划任务）'
  };
  const missing = Object.entries(features)
    .filter(([, v]) => !v)
    .map(([k]) => labels[k] || k);

  return { platform, android, windows, features, missing };
}

/** 一句话总结，给启动日志/控制台用 */
export function describeCapabilities(caps) {
  if (!caps) return '（未探测）';
  if (!caps.missing.length) return `平台 ${caps.platform}：全部能力可用`;
  return `平台 ${caps.platform}：${caps.missing.length} 项不可用 —— ${caps.missing.join('；')}`;
}
