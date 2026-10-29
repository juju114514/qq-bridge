#!/usr/bin/env node
// 黄金快照：抓取 /api/socialV2/prompt 的完整 JSON，用于"重构前后行为一致"的证明。
//
// 为什么需要：
//   拆 bridge.js 是纯搬迁，但"没改逻辑"这句话必须能被验证。
//   唯一的硬证据是：同一组输入，输出逐字段一致。
//
// 用法：
//   node scripts/snapshot-prompt.mjs --save      # 存一份基线（state/snapshots/<ts>/）
//   node scripts/snapshot-prompt.mjs --diff <ts> # 与某次基线比对
//   node scripts/snapshot-prompt.mjs --save --keys "group:123,private:456"
//
// 说明：
//   · 默认抓 config.allow.groups 的第一个群 + 固定私聊 key（可用 --keys 覆盖）
//   · 令牌从 state/console-token 读；端口默认 3100
//   · 比对时忽略「随时间变化」的字段（unreadCount / recentCount / time 等），
//     否则永远有 diff；忽略清单写在 IGNORE 里，可自行扩充

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const getArg = (n, d = "") => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const PORT = Number(getArg("port", process.env.QQB_CONSOLE_PORT || 3100));
const SNAP_DIR = path.join(ROOT, "state", "snapshots");

// 这些字段天然随时间变化，比对时必须忽略
const IGNORE = new Set([
  // 随时间变化
  "time", "unreadCount", "recentCount", "lastAt", "lastMessageAt", "updatedAt",
  "currentWakeConfig", "wakeSafety", "replyTiming", "participation", "memory",
  // 依赖网关实时状态（换网关/刚重连时会变，不是配置加载的行为）
  "nickname", "line",
  // 待判队列是"消费即消失"的运行时队列，抓两次必然不同
  "pending",
  // stickers.context 由"表情使用次数"排序生成：机器人每用一次表情顺序就变，
  // 属于运行数据而不是代码行为（这个 key 在 prompt 载荷里只出现在 stickers 下）
  "context"
]);

function readToken() {
  for (const p of [path.join(ROOT, "state", "console-token")]) {
    try { return fs.readFileSync(p, "utf8").trim(); } catch { /* next */ }
  }
  return "";
}

function defaultKeys() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    const g = (cfg?.allow?.groups || [])[0];
    return [g ? `group:${g}` : "group:1", "private:1"];
  } catch { return ["group:1", "private:1"]; }
}

async function fetchPrompt(key) {
  const token = readToken();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/socialV2/prompt?key=${encodeURIComponent(key)}`, {
    headers: { "x-console-token": token }
  });
  if (!res.ok) throw new Error(`${key} → HTTP ${res.status}`);
  return res.json();
}

/** 去掉易变字段，得到可稳定比较的结构。 */
export function normalize(obj) {
  if (Array.isArray(obj)) return obj.map(normalize);
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (IGNORE.has(k)) continue;
    out[k] = normalize(v);
  }
  return out;
}

function diffKeys(a, b, prefix = "", out = []) {
  const ka = Object.keys(a || {}), kb = Object.keys(b || {});
  for (const k of new Set([...ka, ...kb])) {
    const pa = `${prefix}${k}`;
    const va = a?.[k], vb = b?.[k];
    const ta = typeof va, tb = typeof vb;
    if (va === undefined) { out.push(`${pa}: 新增`); continue; }
    if (vb === undefined) { out.push(`${pa}: 消失`); continue; }
    if (ta !== tb) { out.push(`${pa}: 类型变化 ${ta}→${tb}`); continue; }
    if (va && typeof va === "object") { diffKeys(va, vb, pa + ".", out); continue; }
    if (String(va) !== String(vb)) out.push(`${pa}: ${JSON.stringify(va)} → ${JSON.stringify(vb)}`);
  }
  return out;
}

const SAVE = args.includes("--save");
const DIFF = getArg("diff", "");
const keys = getArg("keys", "") ? getArg("keys").split(",").map((s) => s.trim()).filter(Boolean) : defaultKeys();

if (!SAVE && !DIFF) {
  console.log("用法：--save（存基线）或 --diff <ts>（比对）");
  process.exit(0);
}

if (SAVE) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(SNAP_DIR, ts);
  fs.mkdirSync(dir, { recursive: true });
  for (const k of keys) {
    const data = await fetchPrompt(k);
    const file = path.join(dir, k.replace(/[:/\\]/g, "_") + ".json");
    fs.writeFileSync(file, JSON.stringify(normalize(data), null, 2), "utf8");
    console.log(`  已存 ${k} → ${path.relative(ROOT, file)}`);
  }
  console.log(`基线目录：state/snapshots/${ts}`);
  process.exit(0);
}

// diff
const baseDir = path.join(SNAP_DIR, DIFF);
if (!fs.existsSync(baseDir)) { console.error(`找不到基线：${baseDir}`); process.exit(1); }
let bad = 0;
for (const k of keys) {
  const file = path.join(baseDir, k.replace(/[:/\\]/g, "_") + ".json");
  if (!fs.existsSync(file)) { console.log(`  [跳过] ${k}（基线里没有）`); continue; }
  // 基线也要过一遍 normalize：否则 IGNORE 里新增的字段会被当成"消失"
  const before = normalize(JSON.parse(fs.readFileSync(file, "utf8")));
  const after = normalize(await fetchPrompt(k));
  const d = diffKeys(before, after);
  if (d.length === 0) console.log(`  [一致] ${k}`);
  else { bad += d.length; console.log(`  [差异] ${k}（${d.length} 处）`); d.slice(0, 20).forEach((x) => console.log(`     ${x}`)); }
}
console.log("");
if (bad === 0) console.log("行为一致 ✓");
else { console.log(`共 ${bad} 处差异 —— 搬迁引入了变化，请先修掉再提交`); process.exitCode = 1; }