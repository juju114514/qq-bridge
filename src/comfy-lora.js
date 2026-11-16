/**
 * LoRA 相关的小工具（0.5.65）
 *
 * 拆出来是为了让 comfy-image.js 保持苗条（仓库对单个文件有 +50 行/次的增量闸门），
 * 另外解析和名字对齐这两件事本来就和「提交任务」无关。
 */

/**
 * 从提示词里摘出 `<lora:名字:权重>`，返回纯文本 + 列表。
 * ComfyUI 的 LoraLoader 是独立节点，不能写在提示词里，所以要先摘出来再接线。
 */
export function parseLoraTags(text) {
  const loras = [];
  const cleaned = String(text ?? '')
    .replace(/<lora:([^:>]+)(?::([0-9.]+))?>/gi, (_m, name, w) => {
      loras.push({ name: String(name).trim(), weight: w === undefined ? 1 : Number(w) });
      return '';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { text: cleaned, loras };
}

/** 读 ComfyUI 上装了哪些 LoRA（名字必须和 LoraLoader 列表一模一样，含 .safetensors 后缀） */
export async function listLoras(baseUrl, { timeoutMs = 5000 } = {}) {
  try {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const res = await fetch(`${base}/object_info/LoraLoader`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const data = await res.json();
    const arr = data?.LoraLoader?.input?.required?.lora_name?.[0];
    return Array.isArray(arr) ? arr.filter((x) => x && x !== 'None') : [];
  } catch {
    return [];
  }
}

/**
 * 把用户写的短名（geopelia_sd15）对齐成 ComfyUI 认的全名（geopelia_sd15.safetensors）。
 * 对不上就原样留着，让 ComfyUI 自己报「没有这个 LoRA」——总比静默用错强。
 */
export function resolveLoraNames(loras, available) {
  const list = Array.isArray(available) ? available : [];
  for (const l of Array.isArray(loras) ? loras : []) {
    const want = String(l?.name || '').toLowerCase();
    if (!want) continue;
    const hit = list.find((a) => {
      const low = String(a).toLowerCase();
      return low === want || low === `${want}.safetensors` || low.replace(/\.safetensors$/, '') === want;
    });
    if (hit) l.name = hit;
  }
  return loras;
}
