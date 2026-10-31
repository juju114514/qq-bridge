// 核心库 · 唤醒决策（纯函数，零 IO）
//
// 这里是"门面"：真正的实现从 src/turn-wake.js 逐步搬进来。
// 第一阶段只做 re-export —— 谁都不需要改调用方，行为零变化；
// 后续把实现搬进来时，bridge.js 只需 import 这个入口。
//
// 纯度要求：本文件（以及 src/core/*）不得 import fs / net / http / child_process，
// 由 scripts/test-core-purity.mjs 静态守着。
export { decideWakeReminder } from '../turn-wake.js';