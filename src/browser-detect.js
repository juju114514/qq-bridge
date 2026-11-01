// 找本机能用的 Chromium 内核浏览器（0.4.118）
//
// 为什么不用 Chrome 写死：国内普通用户大多没装 Chrome（常用百度/夸克/360），
// 但 **Windows 10/11 出厂自带 Edge** —— 它是同一个 Chromium 内核，headless 截图行为一致。
// 所以按 Edge → Chrome → 其它 Chromium 的顺序探测，全都没有就降级（调用方自己决定怎么办）。
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  // Edge（系统自带）
  { name: 'edge', paths: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ] },
  // Chrome（装了才用）
  { name: 'chrome', paths: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ] },
  // 其它 Chromium 系（有就用，flags 兼容性未逐一验证）
  { name: 'chromium-ish', paths: [
    'C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe'
  ] }
];

let cached = null;

/**
 * @returns {{name:string, exe:string}|null}
 */
export function findBrowser() {
  if (cached !== null) return cached || null;
  for (const group of CANDIDATES) {
    for (const p of group.paths) {
      try {
        if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
          cached = { name: group.name, exe: p };
          return cached;
        }
      } catch { /* 权限/路径异常都当没有 */ }
    }
  }
  cached = false;   // 记住"没有"，避免每次都扫盘
  return null;
}

/** 测试用：清掉探测缓存 */
export function resetBrowserCache() {
  cached = null;
}

/** headless 截图需要的参数（顺序不重要，但 --user-data-dir 必须唯一，否则会被已开着的浏览器抢走） */
export function screenshotArgs({ profileDir, outFile, width, height }) {
  return [
    '--headless=new',
    // 计划任务/Session 0 里跑时 Chromium 会因沙箱拿不到桌面而直接退出，必须关掉
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    `--user-data-dir=${profileDir}`,
    `--window-size=${Math.round(width)},${Math.round(height)}`,
    `--screenshot=${outFile}`
  ];
}
