/**
 * 生图接口（ComfyUI）：POST /api/image/generate、GET /api/image/file?name=xxx
 *
 * 为什么单独一个 handler：生图是「长任务 + 文件下载」，和角色/配置那类同步 CRUD 不是一回事；
 * 拆出来也好在失败时只影响这一个能力（ComfyUI 没开时其它页面照常用）。
 */

import path from 'node:path';
import { generateImage } from '../comfy-image.js';

export function createImageHandler(deps) {
  const { sendJson, readBody, log, fs, ROOT, getCfg, STATE_DIR } = deps;

  const imageDir = () => path.join(STATE_DIR || path.join(ROOT, 'state'), 'images');
  const imageCfg = () => (getCfg()?.image || {});

  return async function handleImage(req, url) {
    const { pathname } = url;
    const method = req.method;

    // ── POST /api/image/generate ──────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/image/generate') {
      let body = {};
      try { body = await readBody(); } catch { body = {}; }
      const cfg = imageCfg();
      const r = await generateImage({
        baseUrl: String(body.baseUrl || cfg.comfyUrl || 'http://127.0.0.1:8188'),
        prompt: body.prompt,
        negative: body.negative ?? cfg.negative ?? '',
        width: body.width ?? cfg.width,
        height: body.height ?? cfg.height,
        steps: body.steps ?? cfg.steps,
        cfg: body.cfg ?? cfg.cfg,
        seed: body.seed,
        checkpoint: body.checkpoint || cfg.checkpoint,
        timeoutMs: cfg.timeoutMs,
        saveDir: imageDir(),
        logger: log
      });
      sendJson(r, r.ok ? 200 : 200);
      return true;
    }

    // ── GET /api/image/list ──────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/image/list') {
      const dir = imageDir();
      let files = [];
      try {
        files = fs.readdirSync(dir)
          .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
          .map((f) => {
            const st = fs.statSync(path.join(dir, f));
            return { name: f, bytes: st.size, at: st.mtime.toISOString(), url: `/api/image/file?name=${encodeURIComponent(f)}` };
          })
          .sort((a, b) => (a.at < b.at ? 1 : -1))
          .slice(0, 50);
      } catch { files = []; }
      sendJson({ ok: true, items: files, comfyUrl: imageCfg().comfyUrl || 'http://127.0.0.1:8188' });
      return true;
    }

    return false;
  };
}
