#!/usr/bin/env node
// 探测 OneBot action 是否真的可用（**只探只读 action**，绝不产生副作用）。
//
// 为什么需要：静态扫描只能说明"名字在打包产物里"，不代表能调通 ——
// 可能受账号权限、SnowLuma 版本、网关配置影响。这个脚本用浅调用确认。
//
// 用法：
//   node scripts/probe-onebot-actions.mjs                 # 用 config.json 的 snowluma 配置
//   node scripts/probe-onebot-actions.mjs --include-write # 连写类也探（危险，默认关）
//
// 安全：写类 action（set_group_ban/delete_msg/upload_* …）默认**不探**。
// 它们需要真实目标 id，误操作会作用到真群真人身上。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const includeWrite = args.includes('--include-write');

const READ_ONLY = [
  'get_login_info', 'get_status', 'get_version_info',
  'get_group_list', 'get_friend_list',
  'can_send_image', 'can_send_record',
  'get_group_info', 'get_group_member_list',
  'get_stranger_info', 'get_group_honor_info', 'get_group_at_all_remain'
];

const WRITE = [
  'delete_msg', 'set_group_ban', 'set_group_kick', 'set_group_card',
  'upload_group_file', 'set_group_whole_ban'
];

function loadCfg() {
  const p = path.join(ROOT, 'config.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  const cfg = loadCfg();
  const sl = cfg.snowluma || {};
  const base = String(sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = sl.httpToken || sl.accessToken || '';
  const probe = includeWrite ? [...READ_ONLY, ...WRITE] : READ_ONLY;

  console.log(`\n探测 ${probe.length} 个 action（${base}）${includeWrite ? ' **含写类，谨慎**' : '（只读）'}\n`);

  for (const action of probe) {
    let verdict;
    try {
      const res = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(8000)
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* 非 JSON */ }
      const retcode = body?.retcode;
      const status = body?.status;
      if (res.ok && retcode === 0) verdict = '✅ 可用';
      else if (retcode === 1404) verdict = '⚠️ 未知 action（版本/实现不支持）';
      else if (res.status === 404) verdict = '⚠️ HTTP 404（路由不认）';
      else if (res.status === 401 || res.status === 403) verdict = '❌ 鉴权失败（token 不对）';
      else verdict = `⚠️ retcode=${retcode ?? '?'} status=${status ?? res.status}`;
    } catch (error) {
      verdict = `❌ 请求失败：${String(error?.message ?? error).slice(0, 40)}`;
    }
    console.log(`  ${action.padEnd(26)} ${verdict}`);
  }
  console.log('\n提示：⚠️ 不代表一定不能用 —— 有些 action 需要参数（例如 group_id）才有意义。\n');
}

main().catch((error) => {
  console.error(`探测失败：${error?.message ?? error}`);
  process.exitCode = 1;
});