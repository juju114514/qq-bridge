#!/usr/bin/env node
// 模块迁移清单：src/api/*.js 里有哪些 handler、bridge.js 有没有真的接上、接在哪一行。
//
// 背景（踩过的坑）：
//   这个仓库已经拆出很多 src/api 模块，但它们**不一定自己判断 url.pathname** ——
//   多数是被 bridge.js 的 if 链调用。所以"看 bridge 里有 if 就等于没迁"是错的，
//   我就因此差点覆盖掉一个已有模块。
//
// 用法：node scripts/map-routes.mjs
// 输出：docs/routes-map.md（路由归属 + 模块装配情况）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "docs", "routes-map.md");

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".js") || e.name.endsWith(".mjs")) acc.push(p);
  }
  return acc;
}

const files = walk(SRC);
const bridgeLines = fs.readFileSync(path.join(SRC, "bridge.js"), "utf8").split("\n");

// ── 1. 端点归属 ─────────────────────────────────────────────────────
const routes = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  const lines = fs.readFileSync(f, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const re = /url\.pathname\s*===\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(lines[i]))) routes.push({ path: m[1], file: rel, line: i + 1 });
  }
}
const byPath = new Map();
for (const r of routes) {
  const cur = byPath.get(r.path) || { path: r.path, owners: [] };
  cur.owners.push(r);
  byPath.set(r.path, cur);
}
const routeRows = [...byPath.values()].map((r) => {
  const migrated = r.owners.filter((o) => o.file !== "src/bridge.js");
  const inline = r.owners.filter((o) => o.file === "src/bridge.js");
  return {
    path: r.path,
    status: migrated.length ? (inline.length ? "混合" : "已迁") : "内联",
    where: (migrated.length ? migrated : inline).map((o) => `${o.file}:${o.line}`).join("<br>")
  };
}).sort((a, b) => a.path.localeCompare(b.path));

// ── 2. 模块装配 ─────────────────────────────────────────────────────
const modules = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  if (!rel.startsWith("src/api/") && rel !== "src/http/router.js") continue;
  const text = fs.readFileSync(f, "utf8");
  const exports = [...text.matchAll(/export\s+function\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]);
  if (!exports.length) continue;
  const wired = [];
  for (const name of exports) {
    const idx = bridgeLines.findIndex((l) => new RegExp(`\\b${name}\\s*\\(`).test(l));
    if (idx >= 0) wired.push({ name, line: idx + 1 });
  }
  modules.push({ rel, exports, wired, lines: text.split("\n").length });
}

const cnt = (s) => routeRows.filter((r) => r.status === s).length;
const wiredCount = modules.filter((m) => m.wired.length > 0).length;

const md = [];
md.push("# 路由与模块归属索引（自动生成）", "");
md.push(`生成时间：${new Date().toISOString()}`, "");
md.push("> **动路由前先看这里。** 生成：`node scripts/map-routes.mjs`", "");
md.push("## 一、端点归属", "");
md.push("| 统计 | 数量 |", "| --- | --- |");
md.push(`| 端点总数 | ${routeRows.length} |`);
md.push(`| 已迁（实现全在 src/api） | ${cnt("已迁")} |`);
md.push(`| 混合（两边都有判断） | ${cnt("混合")} |`);
md.push(`| **内联（实现仍在 bridge.js）** | ${cnt("内联")} |`, "");
md.push("### 内联（值得抽）", "", "| 路径 | 位置 |", "| --- | --- |");
for (const r of routeRows.filter((x) => x.status === "内联")) md.push(`| \`${r.path}\` | ${r.where} |`);
md.push("", "### 已迁 / 混合", "", "| 路径 | 状态 | 位置 |", "| --- | --- | --- |");
for (const r of routeRows.filter((x) => x.status !== "内联")) md.push(`| \`${r.path}\` | ${r.status} | ${r.where} |`);

md.push("", "## 二、模块装配情况", "");
md.push("> 注意：**很多模块自己不判断 url.pathname**，是被 bridge.js 的 if 链调用。",
        "> 所以「bridge 里有 if」不等于「没迁移」—— 判断依据是这里的「已装配」列。", "");
md.push(`已装配 ${wiredCount} / ${modules.length} 个模块。`, "");
md.push("| 模块 | 行数 | 导出 | 装配位置 |", "| --- | --- | --- | --- |");
for (const m of modules.sort((a, b) => a.rel.localeCompare(b.rel))) {
  const wires = m.wired.length ? m.wired.map((w) => `${w.name}@L${w.line}`).join("<br>") : "**未装配**";
  md.push(`| \`${m.rel}\` | ${m.lines} | ${m.exports.join(", ")} | ${wires} |`);
}

fs.writeFileSync(OUT, md.join("\n") + "\n", "utf8");
console.log(`已生成：${routeRows.length} 端点（内联 ${cnt("内联")} / 已迁 ${cnt("已迁")} / 混合 ${cnt("混合")}）；模块 ${modules.length} 个，已装配 ${wiredCount}`);