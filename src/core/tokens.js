// 核心库 · 计价（纯函数，零 IO）
//
// 输入 usage + 时间，输出人民币；不读配置、不写账本 —— 记账是谁做是另一件事。
export {
  PRICE_TABLE_VERSION,
  DEFAULT_PRICE_TABLE,
  resolvePriceTable,
  normalizeUsage,
  totalTokensOf,
  costOfBuckets,
  priceUsage,
  ZERO_BUCKETS,
  addBuckets,
  subBuckets,
  beijingParts,
  isPeakAt,
  ratesAt,
} from '../model-prices.js';