// 核心库 · 表情挑选（纯函数，零 IO）
//
// 只放"给定清单与情绪，挑哪几张"；读写表情库仍是调用方的事。
export {
  sanitizeStickerText,
  normalizeStickerEntry,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
} from '../sticker-lib.js';