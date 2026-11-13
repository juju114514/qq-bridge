/**
 * 语气/内容许可（personaPolicy）的控制台接口
 *
 *   GET  /api/persona-policy                 读当前策略 + 成年确认名单
 *   POST /api/persona-policy                 写全局 / 按群覆盖 / requireAdultConfirm / note
 *   POST /api/persona-policy/adult           成年确认：{ action:'confirm'|'revoke', gid }
 *
 * 写盘口径和 role.maxInjectChars 一致：先改内存 cfg（立即生效）+ 原子写 config.json（下次启动也在）。
 * 校验在服务端做：非法档位不写，直接 400，避免把 config 写成模型看不懂的值。
 */

import { PROFANITY_LEVELS, NSFW_LEVELS, readAdultList, writeAdultList } from '../persona-policy.js';

export function createPersonaPolicyHandler(deps) {
  const { sendJson, readBody, log, fs, ROOT, STATE_DIR, getCfg, atomicWriteJson } = deps;
  const configFile = () => `${ROOT}/config.json`;
  const adultFile = () => `${STATE_DIR}/persona-adult.json`;

  const normalize = (value, allowed) => {
    if (value === undefined || value === null || value === '') return undefined;
    const v = String(value).toLowerCase();
    return allowed.includes(v) ? v : null;   // null = 非法
  };

  function snapshot() {
    const raw = getCfg()?.personaPolicy || {};
    let adult = [];
    try { adult = [...readAdultList(fs, adultFile())]; } catch { adult = []; }
    return {
      ok: true,
      policy: {
        profanity: raw.profanity || 'off',
        nsfw: raw.nsfw || 'off',
        requireAdultConfirm: raw.requireAdultConfirm !== false,
        note: raw.note || '',
        perGroup: raw.perGroup && typeof raw.perGroup === 'object' ? raw.perGroup : {}
      },
      adult,
      levels: { profanity: PROFANITY_LEVELS, nsfw: NSFW_LEVELS }
    };
  }

  return async function handlePersonaPolicy(req, url) {
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && pathname === '/api/persona-policy') {
      sendJson(snapshot());
      return true;
    }

    // ── 成年确认名单 ─────────────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/persona-policy/adult') {
      const body = await readBody();
      const gid = String(body?.gid ?? '').replace(/\D/g, '');
      if (!gid) { sendJson({ ok: false, error: '群号不能为空' }, 400); return true; }
      const set = readAdultList(fs, adultFile());
      if (String(body?.action || 'confirm') === 'revoke') set.delete(gid);
      else set.add(gid);
      try {
        writeAdultList(fs, adultFile(), set);
      } catch (e) {
        sendJson({ ok: false, error: `写成年名单失败：${String(e?.message ?? e).slice(0, 80)}` }, 500);
        return true;
      }
      log(`[persona-policy] 成年确认${String(body?.action || 'confirm') === 'revoke' ? '移除' : '加入'}：${gid}`);
      sendJson({ ...snapshot() });
      return true;
    }

    // ── 写策略 ──────────────────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/persona-policy') {
      const body = await readBody();
      const profanity = normalize(body?.profanity, PROFANITY_LEVELS);
      const nsfw = normalize(body?.nsfw, NSFW_LEVELS);
      if (profanity === null) { sendJson({ ok: false, error: `profanity 只能是 ${PROFANITY_LEVELS.join(' / ')}` }, 400); return true; }
      if (nsfw === null) { sendJson({ ok: false, error: `nsfw 只能是 ${NSFW_LEVELS.join(' / ')}` }, 400); return true; }

      // perGroup：只保留合法档位，非法键直接报错（避免悄无声息地"保存了但没生效"）
      let perGroup;
      if (body && Object.prototype.hasOwnProperty.call(body, 'perGroup')) {
        if (body.perGroup === null) perGroup = {};
        else if (typeof body.perGroup !== 'object' || Array.isArray(body.perGroup)) {
          sendJson({ ok: false, error: 'perGroup 必须是对象：{"group:<群号>":{profanity,nsfw}}' }, 400);
          return true;
        } else {
          perGroup = {};
          for (const [key, val] of Object.entries(body.perGroup)) {
            if (!/^group:\d+$/.test(key) && key !== '*') {
              sendJson({ ok: false, error: `perGroup 的键必须是 group:<纯数字群号> 或 "*"：${key}` }, 400);
              return true;
            }
            const pv = normalize(val?.profanity, PROFANITY_LEVELS);
            const nv = normalize(val?.nsfw, NSFW_LEVELS);
            if (pv === null || nv === null) {
              sendJson({ ok: false, error: `${key} 的档位不合法` }, 400);
              return true;
            }
            const entry = {};
            if (pv !== undefined) entry.profanity = pv;
            if (nv !== undefined) entry.nsfw = nv;
            if (val?.note !== undefined) entry.note = String(val.note).slice(0, 120);
            perGroup[key] = entry;
          }
        }
      }

      const cfg = getCfg();
      const next = {
        ...(cfg.personaPolicy || {}),
        ...(profanity !== undefined ? { profanity } : {}),
        ...(nsfw !== undefined ? { nsfw } : {}),
        ...(body?.requireAdultConfirm !== undefined ? { requireAdultConfirm: body.requireAdultConfirm !== false } : {}),
        ...(body?.note !== undefined ? { note: String(body.note).slice(0, 200) } : {}),
        ...(perGroup !== undefined ? { perGroup } : {})
      };
      delete next._说明;
      try {
        const file = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
        file.personaPolicy = next;
        atomicWriteJson(configFile(), file);
      } catch (e) {
        sendJson({ ok: false, error: `写 config.json 失败：${String(e?.message ?? e).slice(0, 80)}` }, 500);
        return true;
      }
      cfg.personaPolicy = next;   // 立即生效（不必重启）
      log(`[persona-policy] 已更新：profanity=${next.profanity} nsfw=${next.nsfw} 群覆盖=${Object.keys(next.perGroup || {}).length}`);
      sendJson(snapshot());
      return true;
    }

    return false;
  };
}
