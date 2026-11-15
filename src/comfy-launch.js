/**
 * ComfyUI 启停 + 状态（0.5.65）
 *
 * 为什么要它：控制台点「生图」时，最常见的失败是「ComfyUI 没开」。
 * 以前只能回报一句 "连不上 ComfyUI"，用户还得自己去命令行开。
 * 这里让控制台能：
 *   - 查：除了「端口通不通」，还报模型清单（从 config.image.comfyDir 下的 models/checkpoints 读）
 *   - 启：用 ComfyUI 自己的 venv 启动（--lowvram，适配 3~8GB 显存）
 *
 * 硬约束：
 *   - 不下载模型、不改 ComfyUI 代码（只启动它）
 *   - 已经在跑就复用，绝不重复起第二份（端口探测为准）
 *   - 启动失败把 stderr 尾巴带回去，不吞
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEFAULT_DIR = process.env.QQB_COMFY_DIR || '';
export const DEFAULT_PORT = 8188;

function readDirFiles(dir, exts) {
  try {
    return fs.readdirSync(dir).filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)));
  } catch {
    return [];
  }
}

/** 端口通不通 + 模型清单（不依赖 ComfyUI 的 API，没启动也能报模型） */
export async function comfyStatus({ baseUrl = `http://127.0.0.1:${DEFAULT_PORT}`, dir = DEFAULT_DIR, timeoutMs = 2500 } = {}) {
  const ckptDir = path.join(dir, 'models', 'checkpoints');
  const loraDir = path.join(dir, 'models', 'loras');
  const checkpoints = readDirFiles(ckptDir, ['.safetensors', '.ckpt', '.pt']).map((f) => {
    let bytes = 0;
    try { bytes = fs.statSync(path.join(ckptDir, f)).size; } catch { /* ignore */ }
    return { name: f, bytes, gb: Math.round((bytes / 1024 / 1024 / 1024) * 100) / 100 };
  });
  const loras = readDirFiles(loraDir, ['.safetensors', '.pt']);

  let running = false;
  let stats = null;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) { running = true; stats = await res.json().catch(() => null); }
  } catch { /* 没开就是没开 */ }

  const dev = stats?.devices?.[0];
  return {
    running,
    baseUrl,
    dir,
    checkpoints,
    loras,
    gpu: dev ? { name: dev.name, vramTotal: dev.vram_total, vramFree: dev.vram_free } : null,
    comfyVersion: stats?.system?.comfyui_version || ''
  };
}

/** 启动 ComfyUI（已在跑就返回 started:false） */
export async function startComfy({ dir = DEFAULT_DIR, port = DEFAULT_PORT, log = () => {}, extraArgs = [], waitMs = 25000 } = {}) {
  const py = path.join(dir, 'venv', 'Scripts', 'python.exe');
  const main = path.join(dir, 'main.py');
  if (!fs.existsSync(py)) return { ok: false, started: false, error: `找不到 venv Python：${py}` };
  if (!fs.existsSync(main)) return { ok: false, started: false, error: `找不到 main.py：${main}` };

  // 已在跑就不再起
  try {
    const res = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return { ok: true, started: false, port, note: '本来就在跑' };
  } catch { /* 继续启动 */ }

  const args = [main, '--listen', '127.0.0.1', '--port', String(port), '--lowvram', ...extraArgs];
  log(`[comfy] 启动：${py} ${args.join(' ')}`);
  let child;
  try {
    child = spawn(py, args, { cwd: dir, detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  } catch (e) {
    return { ok: false, started: false, error: `spawn 失败：${String(e?.message ?? e).slice(0, 120)}` };
  }
  let errTail = '';
  try {
    child.stderr?.on('data', (b) => { errTail = (errTail + String(b)).slice(-800); });
  } catch { /* ignore */ }
  child.unref();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return { ok: true, started: true, pid: child.pid, port };
    } catch { /* 还在加载 */ }
  }
  return { ok: false, started: true, pid: child.pid, error: `等了 ${Math.round(waitMs / 1000)} 秒还没起来`, stderr: errTail };
}
