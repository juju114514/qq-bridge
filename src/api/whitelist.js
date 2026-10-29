// 白名单可视化编辑（从 bridge.js 抽出的第五片）
//
//   GET  /api/whitelist  读当前 allow / deny / ownerQQ
//   POST /api/whitelist  写 config.json 并热更新内存
//
// 两个安全细节原样保留：
//   1. fail-fast：配置文件损坏时直接 500，绝不回写（否则会把配置清成只剩 allow/deny）
//   2. ownerQQ 非法值拒绝写入（fail-closed），空值表示清除管理员

export function createWhitelistHandler(deps = {}) {
  const {
    sendJson, readBody, log,
    getCfg, rootDir, path,
    readConfigObject, atomicWriteJson, normalizeOwnerQQ, reconcileSessionPolicies
  } = deps;

  return async function handleWhitelist(req, url) {
    const cfg = getCfg();
    // 原代码里用的是模块级 ROOT；抽出来后由依赖传入
    const ROOT = rootDir;

          if (req.method === 'GET' && url.pathname === '/api/whitelist') {
            sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/whitelist') {
            const body = await readBody();
            const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
            const configFile = path.join(ROOT, 'config.json');
            // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
            const file = readConfigObject(configFile);
            const allow = {
              private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
              groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
            };
            const deny = {
              private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
              groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
            };
            // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
            let ownerQQ = cfg.ownerQQ ?? null;
            if (body.ownerQQ !== undefined) {
              try {
                ownerQQ = normalizeOwnerQQ(body.ownerQQ);
              } catch (error) {
                sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
                return;
              }
            }
            file.allow = allow;
            file.deny = deny;
            file.ownerQQ = ownerQQ;
            atomicWriteJson(configFile, file);
            cfg.allow = { private: allow.private, groups: allow.groups };
            cfg.deny = { private: deny.private, groups: deny.groups };
            cfg.ownerQQ = ownerQQ;
            reconcileSessionPolicies();
            log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
            sendJson({ ok: true, allow, deny, ownerQQ });
            return;
          }
  };
}
