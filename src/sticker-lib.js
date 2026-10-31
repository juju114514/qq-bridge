// 已拆分（P0-γ）：
//   纯函数 → src/core/stickers.js
//   落盘   → src/sticker-store.js
// 这里保留为兼容入口，老代码 import 不用改。
export * from './core/stickers.js';
export * from './sticker-store.js';
