// 安全设置（从 bridge.js 抽出的第六片）
//
//   GET  /api/security  读 interceptNotify + state/ 的 ACL 收紧状态
//   POST /api/security  更新 interceptNotify，或重试收紧 state/ 权限
//
// 两个要点原样保留：
//   1. manualCommand 必须用 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
//      会把子文件 DACL 清空，用户照抄会弄坏自己的 state/
//   2. stateDirHardened 是模块级 let（会变）→ 用 getter/setter 传，不传值

export function createSecurityHandler(deps = {}) {
  const {
    sendJson, readBody, log,
    getCfg, rootDir, path, crypto,
    stateDir, getStateDirHardened, setStateDirHardened,
    manualDirCommand, hardenStateDirAcl,
    readConfigObject, atomicWriteJson
  } = deps;

  return async function handleSecurity(req, url) {
    const cfg = getCfg();
    const ROOT = rootDir;
    // 原代码引用模块级 STATE_DIR；抽出来后由依赖传入（GET 分支需要它拼路径）
    const STATE_DIR = stateDir;

          if (req.method === 'GET' && url.pathname === '/api/security') {
            sendJson({
              security: cfg.security ?? { interceptNotify: true },
              // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
              // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
              // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
              // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
              stateDir: {
                hardened: getStateDirHardened(),
                path: STATE_DIR,
                manualCommand: process.platform === 'win32'
                  ? manualDirCommand(STATE_DIR)
                  : `chmod 700 "${STATE_DIR}"`
              }
            });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/security') {
            const body = await readBody();
            // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
            if (body.rehardenStateDir === true) {
              setStateDirHardened(null);
              hardenStateDirAcl();
              sendJson({ ok: getStateDirHardened() === true, hardened: getStateDirHardened(), path: STATE_DIR });
              return;
            }
            const configFile = path.join(ROOT, 'config.json');
            const file = readConfigObject(configFile);
            const next = { ...(file.security ?? {}), ...body };
            if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
            else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
            file.security = next;
            atomicWriteJson(configFile, file);
            cfg.security = { ...(cfg.security ?? {}), ...next };
            log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
            sendJson({ ok: true, security: cfg.security });
            return;
          }
  };
}
