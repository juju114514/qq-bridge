#!/usr/bin/env node
// 网关能力探测：SnowLuma 与 NapCat 能做的事不一样。
//
// 关键：要区分两种失败
//   · `不支持的Api xxx`   → 网关真没这个能力
//   · `file: is required` → 能力有，只是参数不对
// 早期版本只判 ok/fail，把 SnowLuma 误报成"只读"；实际它支持 add_custom_face，
// 只是要 `file`（图片 URL/路径），而桥接的 collectStickerV2 传的正是 file。
//
// 用法：
//   node scripts/probe-gateway-caps.mjs            # 只读探测
//   node scripts/probe-gateway-caps.mjs --write    # 真写一张（进收藏夹，慎用）
//   node scripts/probe-gateway-caps.mjs --port 3000 --token xxx --json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const getArg = (name, def = "") => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const PORT = Number(getArg("port", process.env.ONEBOT_PORT || 3000));
const AS_JSON = args.includes("--json");
const WRITE = args.includes("--write");

let token = getArg("token", process.env.ONEBOT_TOKEN || "");
if (!token) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    token = cfg?.snowluma?.accessToken || "";
  } catch { /* 匿名探测 */ }
}

const BASE = "http://127.0.0.1:" + PORT;
const SAMPLE_FILE = "https://gxh.vip.qq.com/club/item/parcel/item/D5/EAE80BDFFB3320433DAA8434D4C189/raw300.gif";

const PROBES = [
  { action: "get_login_info", params: {}, label: "登录信息" },
  { action: "get_friend_list", params: {}, label: "好友列表（私聊准入用）" },
  { action: "fetch_custom_face_detail", params: { count: 5 }, label: "读收藏表情" },
  { action: "add_custom_face", params: WRITE ? { file: SAMPLE_FILE } : {}, label: "**写**收藏表情（收藏功能依赖）" },
  { action: "modify_custom_face", params: { emoji_id: "0".repeat(32), desc: "probe" }, label: "改收藏表情备注" }
];

export function classifyResponse({ ok, wording = "" } = {}) {
  if (ok) return "supported";
  const w = String(wording);
  if (/不支持的\s*Api|unsupported|not\s*implemented|unknown\s*action/i.test(w)) return "unsupported";
  if (/required|invalid|missing|cannot\s*extract|schema/i.test(w)) return "needs-args";
  return "failed";
}

async function call(action, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(BASE + "/" + action, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: JSON.stringify({ action, params }),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    const wording = String(data?.wording || data?.message || "");
    return {
      ok: data?.status === "ok" || data?.retcode === 0,
      status: data?.status ?? res.status,
      retcode: data?.retcode ?? null,
      wording: wording.slice(0, 90),
      count: Array.isArray(data?.data) ? data.data.length : null
    };
  } catch (e) {
    return { ok: false, status: "error", wording: String(e?.name === "AbortError" ? "timeout" : (e?.message ?? e)).slice(0, 90) };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const p of PROBES) {
  const r = await call(p.action, p.params);
  results.push({ ...p, ...r, verdict: classifyResponse(r) });
}

if (AS_JSON) {
  console.log(JSON.stringify({ port: PORT, write: WRITE, results }, null, 2));
  process.exit(0);
}

const MARK = { supported: "[可用]", "needs-args": "[支持]", unsupported: "[不支持]", failed: "[失败]" };
console.log("网关能力探测 @ " + BASE + (token ? "（带令牌）" : "（未带令牌）") + (WRITE ? " — 写模式" : " — 只读模式"));
console.log("");
for (const r of results) {
  const extra = r.count != null ? " data=" + r.count + " 条" : "";
  console.log("  " + MARK[r.verdict] + " " + r.action.padEnd(26) + " " + r.label + extra);
  if (r.wording) console.log("           └ " + r.wording);
}

const writeProbe = results.find((r) => r.action === "add_custom_face");
const readProbe = results.find((r) => r.action === "fetch_custom_face_detail");
console.log("");
if (writeProbe?.verdict === "supported") {
  console.log("  结论：可读可写 —— 收藏功能可用。");
  if (WRITE) console.log("        （写模式：收藏夹里可能多了一张探测图，记得清理）");
} else if (writeProbe?.verdict === "needs-args") {
  console.log("  结论：可写，但**需要 file 参数**（能力存在，不是只读）。");
  console.log("        桥接的 collectStickerV2 传的正是 file，所以收藏能成。");
  console.log("        想真验证：加 --write 重跑（会往收藏夹写一张探测图）。");
} else if (writeProbe?.verdict === "unsupported") {
  console.log("  结论：**只读** —— 网关不支持写收藏夹。");
  console.log("        表情策展只能记本地笔记；要真收藏请换网关（SnowLuma 支持）。");
} else {
  console.log("  结论：写入探测失败（既不是不支持也不是缺参数），看上面 wording。");
}
if (readProbe && !readProbe.ok) console.log("  注意：连收藏夹都读不到，收藏相关功能整体不可用。");