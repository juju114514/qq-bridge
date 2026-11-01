// 文本转图片（t2i，0.4.118）
//
// 为什么要有：个人号（OneBot）不吃 markdown，长回复排版全丢；官方通道好了但也不是所有会话都通。
// 把长回复渲染成一张卡片图，任何通道都好看。
//
// 实现取向：**不做常驻浏览器**。每次 spawn 一个 headless 进程截图，用完就退——
// 简单、不占内存、不会因为浏览器崩了卡住桥接。代价是 1~2 秒启动，所以只在"长文本"时走这条路。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { findBrowser, screenshotArgs } from './browser-detect.js';
import { renderHtmlViaCdp, probeCdp } from './t2i-cdp.js';

const DEFAULT_WIDTH = 640;
const MAX_WIDTH = 900;
const DEFAULT_TIMEOUT_MS = 8000;

/** HTML 转义：模型输出里啥都有，必须先转义再拼进模板 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把纯文本排版成卡片 HTML。
 *
 * 细节都是给「QQ 里看图」优化的：
 *  · 行高 1.75、字号 15px —— 手机上缩小后仍然清楚
 *  · 中文优先字体（微软雅黑），行内不折行到半个字
 *  · 保留换行与缩进（white-space: pre-wrap），列表和引用不塌
 *  · 底部小字水印，方便别人知道哪来的
 */
export function buildCardHtml(text, { title = '', width = DEFAULT_WIDTH, footer = '' } = {}) {
  const body = escapeHtml(text).replace(/^\n+|\n+$/g, '');
  const w = Math.max(320, Math.min(Number(width) || DEFAULT_WIDTH, MAX_WIDTH));
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#f4f6fa}
  .card{width:${w}px;margin:18px;padding:22px 24px 18px;background:#fff;border-radius:16px;
        box-shadow:0 8px 26px rgba(22,40,72,.10)}
  h1{margin:0 0 12px;font-size:17px;font-weight:700;color:#16233a;
     padding-bottom:10px;border-bottom:1px solid #e8edf6}
  .body{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;
        font-size:15px;line-height:1.75;color:#2c3a52;
        font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif}
  .foot{margin-top:14px;padding-top:9px;border-top:1px solid #eef2f9;
        font-size:11px;color:#93a2bb;display:flex;justify-content:space-between}
</style></head><body>
<div class="card">
  ${title ? `<h1>${escapeHtml(title)}</h1>` : ''}
  <div class="body">${body}</div>
  <div class="foot"><span>${escapeHtml(footer || 'qq-bridge')}</span><span>${new Date().toLocaleString('zh-CN', { hour12: false })}</span></div>
</div>
</body></html>`;
}

let cachedProfileDir = '';
/** 持久 profile 目录：首次调用时创建 */
function profileDirOf(dir = '') {
  if (dir) cachedProfileDir = dir;
  if (!cachedProfileDir) cachedProfileDir = path.join(os.tmpdir(), 'qqb-t2i-profile');
  try { fs.mkdirSync(cachedProfileDir, { recursive: true }); } catch (e) { return cachedProfileDir; }
  return cachedProfileDir;
}

/**
 * 预热：开机时跑一次空渲染，把 Chromium 的初始化成本提前付掉。
 * 不做的话，用户升级后第一条长消息要等 12 秒才出图。
 */
export async function warmUpT2i({ profileDir = '', log = () => {} } = {}) {
  if (!findBrowser()) return false;
  const profDir = profileDirOf(profileDir);
  const t0 = Date.now();
  const r = await renderTextImage('预热', { width: 320, timeoutMs: 30000, log });
  log(`[t2i] 预热${r ? '完成' : '失败'}，用时 ${Date.now() - t0}ms`);
  return Boolean(r);
}

/** 文本值不值得转图（太短就是浪费） */
export function shouldRenderAsImage(text, { threshold = 150, maxChars = 2400 } = {}) {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  if (t.length > maxChars) return false;          // 太长：一张图也放不下，仍走文本分条
  return t.length >= Math.max(40, Number(threshold) || 150);
}

/**
 * 渲染一张图。失败返回 null（调用方降级发文本），绝不抛。
 *
 * @returns {Promise<{buffer:Buffer, width:number, height:number}|null>}
 */
let queueTail = Promise.resolve();

/** 所有渲染串行：共用一个 profile，并发会互相抢（表现为 exit 0 但没有产物） */
function serialize(task) {
  const run = queueTail.then(task, task);
  queueTail = run.then(() => {}, () => {});
  return run;
}

export async function renderTextImage(text, {
  width = DEFAULT_WIDTH, title = '', footer = '', timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {}, profileDir = '', workRoot = ''
} = {}) {
  return serialize(() => renderTextImageInner(text, {
    width, title, footer, timeoutMs, log, profileDir, workRoot
  }));
}

async function renderTextImageInner(text, { width, title, footer, timeoutMs, log, profileDir, workRoot }) {
  const browser = findBrowser();
  const cdpBase = String(process.env.QQB_T2I_CDP || 'http://127.0.0.1:9222');
  const cdpAlive = await probeCdp(cdpBase);
  if (!browser && !cdpAlive) {
    log('[t2i] 既没有浏览器也没有 CDP 侧车，跳过转图');
    return null;
  }
  const w = Math.max(320, Math.min(Number(width) || DEFAULT_WIDTH, MAX_WIDTH));
  // profile 必须**复用**：新建一次要 12 秒（Chromium 初始化），复用后 1.8 秒。
  // 放 state/ 下而不是临时目录，避免被清理工具删掉又要重付初始化成本。
  const profDir = profileDirOf(profileDir);
  // 不依赖 TEMP：计划任务环境下 TEMP 可能缺失，mkdtemp 会失败且痕迹被 catch 吞掉
  const root = workRoot && workRoot.trim() ? workRoot : os.tmpdir();
  try { fs.mkdirSync(root, { recursive: true }); } catch (e) { log(`[t2i] 建工作目录失败：${e?.message ?? e}`); return null; }
  const workDir = path.join(root, `t2i-${crypto.randomBytes(6).toString('hex')}`);
  const htmlFile = path.join(workDir, 'card.html');
  const pngFile = path.join(workDir, 'card.png');
  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(htmlFile, buildCardHtml(text, { title, width: w, footer }), 'utf8');

    // 高度先给个够用的值；Chromium 截图不会自动长，所以按行数估
    const lines = String(text).split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 26)), 0);
    const height = Math.min(2400, 160 + lines * 27 + (title ? 46 : 0));

    // ① 优先走常驻侧车（快、且不受"桥接里 spawn 不动"影响）
    if (cdpAlive) {
      const buf = await renderHtmlViaCdp(htmlFile, { width: w + 36, height, cdpBase, log });
      if (buf && buf.length > 1024) {
        log(`[t2i] CDP 渲染成功（${Math.round(buf.length / 1024)}KB）`);
        return { buffer: buf, width: w + 36, height, browser: 'cdp' };
      }
      log('[t2i] CDP 没出图，退回 spawn');
    }
    if (!browser) return null;
    const result = await runBrowser(browser.exe, screenshotArgs({
      profileDir: profDir, outFile: pngFile, width: w + 36, height
    }).concat([`file:///${htmlFile.replace(/\\/g, '/')}`]), timeoutMs);

    if (!result.ok || !fs.existsSync(pngFile)) {
      // 典型症状：exit 0 但没有产物 —— 说明这次调用被转交给了别的浏览器实例。
      // 用一次性 profile 再来一次（慢，但一定独立）。
      const freshProfile = path.join(workDir, 'profile');
      fs.mkdirSync(freshProfile, { recursive: true });
      const retry = await runBrowser(browser.exe, screenshotArgs({
        profileDir: freshProfile, outFile: pngFile, width: w + 36, height
      }).concat([`file:///${htmlFile.replace(/\\/g, '/')}`]), Math.max(timeoutMs, 20000));
      log(`[t2i] 首次渲染没出图（${result.why}），改用独立 profile 重试`);
      if (!retry.ok || !fs.existsSync(pngFile)) {
        const tail = String(retry.stderr || result.stderr || '').split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 260);
        log(`[t2i] 渲染失败（${browser.name}, ${retry.why}）${tail ? ' :: ' + tail : ''}`);
        return null;
      }
    }
    const buffer = fs.readFileSync(pngFile);
    if (buffer.length < 1024) {
      log('[t2i] 产出太小，判定失败');
      return null;
    }
    return { buffer, width: w + 36, height, browser: browser.name };
  } catch (error) {
    log(`[t2i] 异常：${error?.message ?? error}`);
    return null;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* 清理失败无所谓 */ }
  }
}

/** 跑一次 headless，返回是否成功退出（超时就杀掉） */
function runBrowser(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let child;
    let stderr = '';
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      child.stderr?.on('data', (d) => { if (stderr.length < 2000) stderr += d.toString(); });
    } catch (e) {
      resolve({ ok: false, why: 'spawn error: ' + (e?.message ?? e) });
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* 已经退了 */ }
      resolve({ ok: false, why: `timeout ${timeoutMs}ms`, stderr });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, why: 'error event', stderr });
    });
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, why: `exit ${code}`, stderr });
    });
  });
}
