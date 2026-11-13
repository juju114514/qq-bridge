/**
 * ComfyUI 生图（0.5.64）
 *
 * 为什么按 HTTP API 接：ComfyUI 本身就是本地服务（默认 :8188），有稳定的 /prompt + /history + /view 三个接口，
 * 不需要在桥接里塞 WebSocket 或图片模型依赖。
 *
 * 设计取舍：
 *   · 默认用**内置 txt2img 工作流**（只依赖一个 checkpoint），不自带模型文件
 *   · 想用自己的工作流：配置 `image.workflowFile` 指向一个 ComfyUI API 格式的 JSON，
 *     里面把正向提示词节点 id 写进 `image.promptNode`（默认 "6"）、负向 `image.negativeNode`（默认 "7"）
 *   · ComfyUI 没开时返回**可操作错误**（不是堆栈），控制台能直接显示
 *   · 生成结果落到 state/images/<时间戳>-<id>.png，并返回可直接访问的 URL（桥接自己托管）
 */

import fs from 'node:fs';
import path from 'node:path';

/** 内置的最小 txt2img 工作流（ComfyUI API 格式）。 */
export function defaultWorkflow({ prompt, negative = '', width = 768, height = 768, steps = 24, cfg = 7, seed = 0, checkpoint = '', filenamePrefix = 'qqb' } = {}) {
  return {
    '3': { class_type: 'KSampler', inputs: { seed, steps, cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: String(prompt ?? ''), clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: String(negative ?? ''), clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: filenamePrefix, images: ['8', 0] } }
  };
}

/** 读 ComfyUI 上装了什么 checkpoint（用来填默认值，避免用户手抄模型名）。 */
export async function listCheckpoints(baseUrl, { timeoutMs = 5000 } = {}) {
  const res = await fetch(joinUrl(baseUrl, '/object_info/CheckpointLoaderSimple'), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`ComfyUI 返回 ${res.status}`);
  const data = await res.json();
  const node = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  return Array.isArray(node) ? node.map(String) : [];
}

function joinUrl(base, p) {
  return String(base || 'http://127.0.0.1:8188').replace(/\/+$/, '') + p;
}

/**
 * 提交一次生成、等它完成、把图片存到本地。
 * @param {{baseUrl:string, prompt:string, negative?:string, width?:number, height?:number, steps?:number,
 *          cfg?:number, seed?:number, checkpoint?:string, workflow?:object, saveDir:string,
 *          timeoutMs?:number, pollMs?:number, logger?:Function}} opts
 */
export async function generateImage(opts = {}) {
  const baseUrl = String(opts.baseUrl || 'http://127.0.0.1:8188');
  const prompt = String(opts.prompt ?? '').trim();
  if (!prompt) return { ok: false, error: '提示词不能为空' };
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};
  const timeoutMs = Number(opts.timeoutMs) || 120000;
  const pollMs = Math.max(300, Number(opts.pollMs) || 800);
  const saveDir = String(opts.saveDir || path.join(process.cwd(), 'state', 'images'));

  // 0) 先探一下 ComfyUI 在不在（最常见的失败，给一句人话）
  try {
    const health = await fetch(joinUrl(baseUrl, '/system_stats'), { signal: AbortSignal.timeout(4000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (e) {
    return {
      ok: false,
      error: `连不上 ComfyUI（${baseUrl}）：${String(e?.message ?? e).slice(0, 80)}。先启动 ComfyUI，或把 image.comfyUrl 改成实际地址`
    };
  }

  // 1) 选 checkpoint（没指定就取第一个）
  let checkpoint = String(opts.checkpoint || '').trim();
  if (!checkpoint) {
    try {
      const list = await listCheckpoints(baseUrl);
      checkpoint = list[0] || '';
    } catch { /* 忽略：让它自己报缺模型 */ }
  }
  if (!checkpoint) {
    return { ok: false, error: 'ComfyUI 里没有可用的 checkpoint（把模型放进 models/checkpoints，或在配置里指定 image.checkpoint）' };
  }

  // 2) 提交
  const workflow = opts.workflow || defaultWorkflow({
    prompt,
    negative: opts.negative ?? '',
    width: Math.max(256, Math.min(2048, Number(opts.width) || 768)),
    height: Math.max(256, Math.min(2048, Number(opts.height) || 768)),
    steps: Math.max(1, Math.min(80, Number(opts.steps) || 24)),
    cfg: Number(opts.cfg) || 7,
    seed: Number.isFinite(Number(opts.seed)) ? Number(opts.seed) : Math.floor(Math.random() * 1e15),
    checkpoint
  });
  const clientId = 'qqb-' + Math.random().toString(36).slice(2);
  let submitted;
  try {
    const res = await fetch(joinUrl(baseUrl, '/prompt'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      signal: AbortSignal.timeout(15000)
    });
    submitted = await res.json().catch(() => ({}));
    if (!res.ok || submitted?.error) {
      const detail = submitted?.error?.message || submitted?.error || `HTTP ${res.status}`;
      return { ok: false, error: `ComfyUI 拒绝任务：${String(detail).slice(0, 160)}` };
    }
  } catch (e) {
    return { ok: false, error: `提交任务失败：${String(e?.message ?? e).slice(0, 120)}` };
  }
  const promptId = submitted?.prompt_id;
  if (!promptId) return { ok: false, error: 'ComfyUI 没返回 prompt_id' };

  // 3) 轮询历史
  const t0 = Date.now();
  let entry = null;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const res = await fetch(joinUrl(baseUrl, `/history/${promptId}`), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      entry = data?.[promptId] || null;
      if (entry?.status?.completed === true || entry?.outputs) break;
    } catch { /* 继续等 */ }
  }
  if (!entry?.outputs) return { ok: false, error: `等了 ${Math.round((Date.now() - t0) / 1000)} 秒还没出图（ComfyUI 在排队，或模型太大）` };

  // 4) 取第一张图
  let imageRef = null;
  for (const node of Object.values(entry.outputs)) {
    const imgs = Array.isArray(node?.images) ? node.images : [];
    if (imgs.length) { imageRef = imgs[0]; break; }
  }
  if (!imageRef?.filename) return { ok: false, error: '生成完成但输出里没有图片' };

  // 5) 下载落盘
  fs.mkdirSync(saveDir, { recursive: true });
  const q = new URLSearchParams({ filename: imageRef.filename, subfolder: imageRef.subfolder || '', type: imageRef.type || 'output' });
  const imgRes = await fetch(joinUrl(baseUrl, `/view?${q.toString()}`), { signal: AbortSignal.timeout(30000) });
  if (!imgRes.ok) return { ok: false, error: `下载图片失败：HTTP ${imgRes.status}` };
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const safeName = `${Date.now()}-${promptId.slice(0, 8)}.png`;
  const file = path.join(saveDir, safeName);
  fs.writeFileSync(file, buf);
  log(`[comfy] 出图 ${safeName}（${Math.round(buf.length / 1024)} KB，${Math.round((Date.now() - t0) / 1000)} 秒）`);

  const dataUrl = buf.length <= 3 * 1024 * 1024 ? 'data:image/png;base64,' + buf.toString('base64') : '';
  return {
    ok: true,
    file,
    dataUrl,
    bytes: buf.length,
    seconds: Math.round((Date.now() - t0) / 1000),
    checkpoint,
    promptId,
    url: `/api/image/file?name=${encodeURIComponent(safeName)}`
  };
}
