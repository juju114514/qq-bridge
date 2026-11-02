// 对模型隐藏真实 QQ 号（0.4.122）
//
// 上游 config 有 `socialV2.privacy.exposeUserId`，fork 迁移时这个键和它的处理一起丢了
// （预演实测：fork 删掉 5 个上游键，其中就有它，且 fork 源码里 0 处引用）。
// 结果是：群友没设昵称时，`cleanSenderName` 的 fallback 会直接把**真实 QQ 号**喂给模型，
// 模型再原样说出来，就变成"在群里公开某人的 QQ 号"。
//
// 这里的取态：**默认不暴露**。要暴露就在 config.json 写 `socialV2.privacy.exposeUserId: true`。

/**
 * QQ 号脱敏：保留后 4 位（方便人自己认人，但不足以定位账号）。
 * 非纯数字（真昵称、占位符）原样返回 —— 不能把昵称也打码。
 * @param {string|number} id
 * @returns {string}
 */
export function maskQqId(id) {
  const s = String(id ?? '').trim();
  if (!s) return '群友';
  if (!/^\d{5,}$/.test(s)) return s;              // 长度不够/不是纯数字（昵称、占位）就别动
  return `群友${s.slice(-4)}`;
}

/**
 * 决定一个"名字"最终给模型看什么。
 * @param {string} name 昵称（可能为空）
 * @param {string|number} fallbackId 昵称为空时的兜底（通常是 QQ 号）
 * @param {{exposeUserId?: boolean}} privacy
 */
export function senderNameForModel(name, fallbackId, privacy = {}) {
  const clean = String(name ?? '').trim();
  if (clean) return clean;
  const raw = String(fallbackId ?? '').trim();
  if (!raw) return '群友';
  return privacy?.exposeUserId === true ? raw : maskQqId(raw);
}

/** 默认值：不暴露 */
export const DEFAULT_PRIVACY = Object.freeze({ exposeUserId: false });
