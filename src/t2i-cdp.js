// t2i 的 CDP 渲染通道（0.4.119）
//
// 背景：从桥接进程 spawn Edge 会「exit 0 但不产出」（计划任务上下文里的怪问题）。
// 解法：让浏览器**由启动器/用户会话**常驻一个 headless 实例，桥接只通过 CDP 连它截图。
//   · 不 spawn → 绕开上面那个问题
//   · 常驻 → 每次截图 ~200ms，而不是 1.8s
//   · 崩了只影响截图，不影响桥接
import fs from 'node:fs';

const DEFAULT_CDP = 'http://127.0.0.1:9222';

/** 探一下 CDP 端口有没有活的浏览器 */
export async function probeCdp(base = DEFAULT_CDP, timeoutMs = 1200) {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = await res.json();
    return { webSocketDebuggerUrl: String(j.webSocketDebuggerUrl || ''), browser: String(j.Browser || '') };
  } catch {
    return null;
  }
}

/**
 * 用 CDP 把 HTML 渲染成 PNG。
 * @returns {Promise<Buffer|null>}
 */
export async function renderHtmlViaCdp(htmlFile, { width, height, cdpBase = DEFAULT_CDP, timeoutMs = 6000, log = () => {} } = {}) {
  const info = await probeCdp(cdpBase);
  if (!info) { log('[t2i] CDP 不可用'); return null; }

  // 新建一个标签页（新版 Chromium 要求 PUT）
  let targetWs = '';
  const base = cdpBase.replace(/\/+$/, '');
  for (const method of ['PUT', 'GET']) {
    try {
      const res = await fetch(`${base}/json/new?about:blank`, { method, signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j?.webSocketDebuggerUrl) { targetWs = j.webSocketDebuggerUrl; break; }
    } catch { /* 换下一种 */ }
  }
  if (!targetWs) { log('[t2i] 开新标签页失败'); return null; }

  const ws = new WebSocket(targetWs);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => {
      if (pending.has(mid)) { pending.delete(mid); reject(new Error(`${method} 超时`)); }
    }, timeoutMs);
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg.id || !pending.has(msg.id)) return;
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(String(msg.error.message || 'CDP error')));
      else resolve(msg.result);
    });

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    const url = `file:///${htmlFile.replace(/\\/g, '/')}`;
    await send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 350));   // 等字体/布局稳定（本地文件，很快）
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const data = shot?.data;
    if (!data) return null;
    return Buffer.from(data, 'base64');
  } catch (error) {
    log(`[t2i] CDP 渲染失败：${error?.message ?? error}`);
    return null;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    // 关掉这个标签页，避免越攒越多
    try { await fetch(`${base}/json/close/${targetWs.split('/').pop()}`, { signal: AbortSignal.timeout(1500) }); } catch { /* ignore */ }
  }
}

/** 写一个临时 html 文件（CDP 走 file:// 最省事，不用处理 data: 编码） */
export function writeTempHtml(dir, html) {
  const file = `${dir}/card.html`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return file;
}
