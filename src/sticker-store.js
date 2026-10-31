// 表情包 · 落盘部分（唯一碰 fs 的地方）
// 纯逻辑在 src/core/stickers.js；这里只负责 state/stickers.json 的读写。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './atomic-write.js';
import { normalizeStickerEntry } from './core/stickers.js';

export function loadStickerStore(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return []; // 还没有库文件 = 首次使用
    throw new Error(`表情库读取失败（${error?.message ?? error}）`);
  }
  try {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('顶层不是数组');
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch (error) {
    throw new Error(`表情库内容损坏（${error?.message ?? error}），已拒绝按空库继续以免覆盖已有收藏`);
  }
}

export function saveStickerStore(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 原子写走唯一实现：唯一临时名 + 失败自动清理 + Windows EPERM 退避重试
  //（历史上这里自己写 tmp+rename：随机名残留没人清、固定名会被并发覆盖）
  atomicWriteJson(file, entries);
}

// 把 SnowLuma 返回的 QQ 收藏表情详情合并进本地库。
// 保留本地 AI 认知字段（localNote/tags/usage/useCount/lastUsedAt/lastContext），
// 只更新 QQ 侧字段（id/resId/url/md5/desc）。