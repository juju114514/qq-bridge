/**
 * socialV2 —— C3a：QQ 空间 + 攻略
 *
 *   POST /api/socialV2/qzone              发说说 / 列自己的说说（仅管理员私聊）
 *   POST /api/socialV2/qzone-feeds        好友动态（只读，可带识图）
 *   POST /api/socialV2/qzone-user-posts   看某人的说说（可带识图）
 *   POST /api/socialV2/qzone-like         点赞/取消赞（每日 50 条上限）
 *   POST /api/socialV2/qzone-comment      评论（每日 20 条上限）
 *   POST /api/socialV2/guide              攻略：list/get/template/send
 *
 * 每日配额沿用原实现的 globalThis 记账（`__qzoneDaily` 等），重启后归零，
 * 与迁移前完全一致 —— 换成模块内变量反而会改变原有语义。
 */

export function createSocialV2QzoneHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    fs,
    path,
    getCfg,
    getMode,
    agentTokenOk,
    v2SessionAllowed,
    onebotHttpAction,
    appendActivity,
    ensureDirSafe,
    resolveRuntimeDir,
    sendGuideTemplate,
    getSelfUserId,
    safeFetchBuffer,
    describeImageBuffer,
  } = deps;

  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  return async function handleSocialV2Qzone(req, url) {
    if (req.method !== 'POST') return false;
    const { pathname } = url;

    // ── POST /api/socialV2/guide（攻略：list/get/template/send）────────────
    if (pathname === '/api/socialV2/guide') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
      const action = String(body.action ?? 'send').trim();
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      const slugOf = (s) => String(s || '').trim().replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'untitled';
      const DIR = path.join(ensureDirSafe(resolveRuntimeDir('QQBOT_DATA', 'data', '')), 'guides');

      if (action === 'list') {
        try {
          const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
          const list = files.map((f) => {
            try {
              const g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
              return { game: g.game, updatedAt: g.updatedAt, sections: (g.sections || []).length };
            } catch { return null; }
          }).filter(Boolean);
          sendJson({ ok: true, count: list.length, guides: list });
        } catch (error) {
          sendJson({ ok: false, error: `读取失败：${error?.message ?? error}` }, 500);
        }
        return true;
      }

      if (action === 'get') {
        const game = String(body.game ?? '').trim();
        const p = path.join(DIR, slugOf(game) + '.json');
        if (!fs.existsSync(p)) { sendJson({ ok: true, found: false, game, note: '没有缓存，需要联网查' }); return true; }
        try {
          const g = JSON.parse(fs.readFileSync(p, 'utf8'));
          sendJson({ ok: true, found: true, game: g.game, updatedAt: g.updatedAt, sections: g.sections || [] });
        } catch (error) {
          sendJson({ ok: false, error: `缓存损坏：${error?.message ?? error}` }, 500);
        }
        return true;
      }

      if (action === 'template') {
        const wanted = String(body.game ?? '').trim();
        const topic = String(body.topic ?? '').trim();
        if (!wanted) { sendJson({ ok: false, error: 'game 不能为空（支持模糊匹配）' }, 400); return true; }
        try {
          const r = await sendGuideTemplate(key, wanted, topic);
          if (r.ok && r.found) {
            sendJson({
              ok: true, found: true, game: r.game, sections: r.sections,
              topic: r.topic || '', updatedAt: r.updatedAt,
              note: `已按模板发出《${r.game}》${r.topic ? '「' + r.topic + '」' : ''}攻略卡片`,
            });
          } else if (r.ok) {
            sendJson({ ok: true, found: false, game: wanted, topic: r.topic || '', note: '本地没有该游戏的攻略缓存，需要联网整理后用 action=send 存一份' });
          } else {
            sendJson({ ok: false, error: r.error || '发送失败' }, 502);
          }
        } catch (error) {
          sendJson({ ok: false, error: `发送失败：${error?.message ?? error}` }, 502);
        }
        return true;
      }

      const game = String(body.game ?? '').trim().slice(0, 40);
      const sections = Array.isArray(body.sections) ? body.sections : [];
      if (!game) { sendJson({ ok: false, error: 'game 不能为空（游戏名）' }, 400); return true; }
      if (!sections.length) { sendJson({ ok: false, error: 'sections 不能为空（攻略分段）' }, 400); return true; }
      const clean = sections.slice(0, 8).map((s) => ({
        title: String(s?.title ?? '').slice(0, 30),
        content: String(s?.content ?? '').slice(0, 900),
        image: String(s?.image ?? '').slice(0, 500),
        topics: Array.isArray(s?.topics) ? s.topics.map((t) => String(t).slice(0, 8)).slice(0, 4) : [],
      })).filter((s) => s.content || s.image);

      const botName = '小鲸鱼';
      const uin = String(getSelfUserId() || '');
      const nodes = [{ type: 'node', data: { name: botName, uin, content: `【${game}】攻略整理（${new Date().toLocaleDateString('zh-CN')}）` } }];
      for (const s of clean) {
        const segs = [];
        const textPart = (s.title ? `${s.title}\n` : '') + s.content;
        if (textPart.trim()) segs.push({ type: 'text', data: { text: textPart } });
        if (s.image) {
          let file = s.image;
          try {
            if (!/^https?:\/\//i.test(file) && !file.startsWith('base64://') && fs.existsSync(file)) {
              const st = fs.statSync(file);
              file = st.size <= 4 * 1024 * 1024 ? 'base64://' + fs.readFileSync(file).toString('base64') : '';
            }
          } catch { file = ''; }
          if (file) segs.push({ type: 'image', data: { file } });
        }
        if (segs.length) nodes.push({ type: 'node', data: { name: botName, uin, content: segs } });
      }
      const km = /^(group|private):(\d+)$/.exec(key);
      if (!km) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      try {
        const isGroup = km[1] === 'group';
        const idn = Number(km[2]);
        const res = isGroup
          ? await onebotHttpAction('send_group_forward_msg', { group_id: idn, messages: nodes }, { timeoutMs: 30000 })
          : await onebotHttpAction('send_private_forward_msg', { user_id: idn, messages: nodes }, { timeoutMs: 30000 });
        if (res && (res.status === 'failed' || (res.retcode && res.retcode !== 0))) {
          sendJson({ ok: false, error: String(res.wording || res.message || '发送失败') }, 502);
          return true;
        }
        if (body.save !== false) {
          try {
            fs.mkdirSync(DIR, { recursive: true });
            fs.writeFileSync(path.join(DIR, slugOf(game) + '.json'),
              JSON.stringify({ game, updatedAt: new Date().toISOString(), sections: clean }, null, 2), 'utf8');
          } catch { /* 缓存失败不影响发送 */ }
        }
        log(`[guide] ${key} 已发攻略「${game}」（${clean.length} 段）`);
        appendActivity(`${key} 攻略：${game}`);
        sendJson({ ok: true, game, sections: clean.length, note: `已用合并转发把《${game}》攻略发出去` });
      } catch (error) {
        sendJson({ ok: false, error: `发送失败：${error?.message ?? error}` }, 502);
      }
      return true;
    }

    // ── POST /api/socialV2/qzone（发说说 / 列自己的说说）──────────────────
    if (pathname === '/api/socialV2/qzone') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
      const action = String(body.action ?? 'publish').trim();
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      const ownerKey = `private:${String(getCfg().ownerQQ ?? '')}`;
      if (key !== ownerKey) { sendJson({ ok: false, error: '发动态仅限管理员私聊' }, 403); return true; }
      if (action === 'list') {
        try {
          const res = await onebotHttpAction('get_qzone_msg_list', { pos: 0, num: 10 }, { timeoutMs: 20000 });
          const list = (res?.data?.msglist ?? []).map((m) => ({
            tid: m.tid, content: m.content, time: m.time,
            images: Array.isArray(m.images) ? m.images.length : 0,
          }));
          sendJson({ ok: true, total: res?.data?.total ?? list.length, posts: list });
        } catch (error) {
          sendJson({ ok: false, error: `读取失败：${error?.message ?? error}` }, 502);
        }
        return true;
      }
      const content = String(body.content ?? '').trim();
      if (!content) { sendJson({ ok: false, error: 'content 不能为空（说说正文）' }, 400); return true; }
      if (content.length > 300) { sendJson({ ok: false, error: 'content 太长（上限 300 字）' }, 400); return true; }
      const today = todayStr();
      if (!globalThis.__qzoneDaily || globalThis.__qzoneDaily.date !== today) globalThis.__qzoneDaily = { date: today, count: 0 };
      if (globalThis.__qzoneDaily.count >= 5) { sendJson({ ok: false, error: '今天动态发够 5 条了，明天再发' }, 429); return true; }
      const payload = { content };
      if (Array.isArray(body.images) && body.images.length) payload.images = body.images.map((x) => String(x)).slice(0, 9);
      try {
        const res = await onebotHttpAction('send_qzone_msg', payload, { timeoutMs: 30000 });
        if (res && (res.status === 'failed' || (res.retcode && res.retcode !== 0))) {
          sendJson({ ok: false, error: String(res.wording || res.message || '发送失败') }, 502);
          return true;
        }
        globalThis.__qzoneDaily.count += 1;
        log(`[qzone] 已发动态（${content.length} 字，今日第 ${globalThis.__qzoneDaily.count} 条）`);
        appendActivity(`${key} 发动态：${content.slice(0, 40)}`);
        sendJson({ ok: true, note: `已发到 QQ 空间：${content.slice(0, 30)}`, todayCount: globalThis.__qzoneDaily.count });
      } catch (error) {
        sendJson({ ok: false, error: `发送失败：${error?.message ?? error}` }, 502);
      }
      return true;
    }

    // ── POST /api/socialV2/qzone-feeds（好友动态）──────────────────────────
    if (pathname === '/api/socialV2/qzone-feeds') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const pos = Math.max(0, Number(body.pos) || 0);
      const num = Math.max(1, Math.min(20, Number(body.num) || 5));
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      try {
        const res = await onebotHttpAction('get_qzone_feeds', { pos, num }, { timeoutMs: 25000 });
        const describe = body.describe === true;
        const feedsRaw = res?.data?.feeds ?? [];
        const feeds = [];
        for (const f of feedsRaw) {
          // html 里扒一段可读正文，够模型判断值不值得评论
          const html = String(f.html || '');
          const plain = html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim();
          const imgs = [];
          for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
            let u = m[1];
            if (u.startsWith('//')) u = 'https:' + u;
            if (!/^https?:/i.test(u)) continue;
            if (/emoji|qzone\.qq\.com\/qzone\/emotion|gif\.qpic\.cn/i.test(u)) continue;
            if (!imgs.includes(u)) imgs.push(u);
          }
          const item = {
            uin: f.uin,
            nickname: String(f.nickname || ''),
            tid: String(f.key || ''),
            appid: f.appid,
            time: f.time,
            liked: !!f.liked,
            preview: plain.slice(0, 160),
            images: imgs.slice(0, 3),
          };
          if (describe && item.images.length) {
            const descs = [];
            for (const u of item.images.slice(0, 2)) {
              try {
                const img = await safeFetchBuffer(u, 8 * 1024 * 1024);
                if (img?.buffer) {
                  const d = await describeImageBuffer(img.buffer);
                  if (d) descs.push(d);
                }
              } catch { /* 单张失败无所谓 */ }
            }
            if (descs.length) item.imageDesc = descs.join(' ／ ');
          }
          if (item.tid && !/^advertisement/.test(item.tid)) feeds.push(item);
        }
        sendJson({ ok: true, count: feeds.length, hasMore: !!res?.data?.hasMore, described: describe, feeds });
      } catch (error) {
        sendJson({ ok: false, error: `读取失败：${error?.message ?? error}` }, 502);
      }
      return true;
    }

    // ── POST /api/socialV2/qzone-user-posts（看某人的说说）──────────────────
    if (pathname === '/api/socialV2/qzone-user-posts') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const targetUin = String(body.targetUin ?? body.uin ?? '').trim();
      const num = Math.max(1, Math.min(20, Number(body.num) || 5));
      const pos = Math.max(0, Number(body.pos) || 0);
      const describe = body.describe !== false;
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!/^[1-9]\d{4,11}$/.test(targetUin)) { sendJson({ ok: false, error: 'targetUin 必须是 QQ 号' }, 400); return true; }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken) {
        if (!agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
        if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      }
      try {
        const res = await onebotHttpAction('get_qzone_msg_list', { target_uin: Number(targetUin), pos, num }, { timeoutMs: 25000 });
        const raw = res?.data?.msglist ?? [];
        const posts = [];
        for (const m of raw) {
          const tid = String(m.tid || '');
          if (!tid) continue;
          const text = String(m.content || '').replace(/\[em\][^[]*\[\/em\]/g, '').replace(/\s+/g, ' ').trim();
          const imgs = (Array.isArray(m.images) ? m.images : [])
            .map((x) => (typeof x === 'string' ? x : (x?.url || x?.picurl || '')))
            .filter((u) => /^https?:/i.test(u));
          const item = { tid, content: text.slice(0, 200), time: m.time, images: imgs.slice(0, 3) };
          if (describe && imgs.length) {
            const descs = [];
            for (const u of imgs.slice(0, 2)) {
              try {
                const buf = await safeFetchBuffer(u, 8 * 1024 * 1024);
                if (buf?.buffer) {
                  const d = await describeImageBuffer(buf.buffer);
                  if (d) descs.push(d);
                }
              } catch { /* 单张失败忽略 */ }
            }
            if (descs.length) item.imageDesc = descs.join(' ／ ');
          }
          posts.push(item);
        }
        sendJson({ ok: true, targetUin, total: res?.data?.total ?? posts.length, count: posts.length, posts });
      } catch (error) {
        sendJson({ ok: false, error: `读取失败：${error?.message ?? error}` }, 502);
      }
      return true;
    }

    // ── POST /api/socialV2/qzone-like（点赞 / 取消赞）──────────────────────
    if (pathname === '/api/socialV2/qzone-like') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const tid = String(body.tid ?? '').trim();
      const targetUin = String(body.targetUin ?? body.uin ?? '').trim();
      const abstime = Math.max(0, Number(body.abstime) || 0);
      const unlike = body.unlike === true || String(body.action || '') === 'unlike';
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (!tid) { sendJson({ ok: false, error: 'tid 不能为空（来自 qzone-feeds 的 tid）' }, 400); return true; }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken) {
        if (!agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
        if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      }
      const today = todayStr();
      if (!globalThis.__qzoneLikeDaily || globalThis.__qzoneLikeDaily.date !== today) globalThis.__qzoneLikeDaily = { date: today, count: 0 };
      if (!unlike && globalThis.__qzoneLikeDaily.count >= 50) { sendJson({ ok: false, error: '今天空间点赞够 50 条了' }, 429); return true; }
      try {
        const payload = { tid };
        if (targetUin && /^\d+$/.test(targetUin)) payload.target_uin = Number(targetUin);
        if (abstime) payload.abstime = abstime;
        const res = await onebotHttpAction(unlike ? 'unlike_qzone' : 'like_qzone', payload, { timeoutMs: 25000 });
        if (res && (res.status === 'failed' || (res.retcode && res.retcode !== 0))) {
          sendJson({ ok: false, error: String(res.wording || res.message || '点赞失败') }, 502);
          return true;
        }
        if (!unlike) globalThis.__qzoneLikeDaily.count += 1;
        log(`[qzone] ${unlike ? '取消赞' : '点赞'} tid=${tid} uin=${targetUin || '-'}${unlike ? '' : `（今日第 ${globalThis.__qzoneLikeDaily.count} 条）`}`);
        appendActivity(`${key} 空间${unlike ? '取消赞' : '点赞'}：${tid.slice(0, 16)}`);
        sendJson({
          ok: true, tid, targetUin: targetUin || null, unlike,
          todayCount: globalThis.__qzoneLikeDaily.count,
          note: unlike ? '已取消点赞' : '已点赞',
        });
      } catch (error) {
        sendJson({ ok: false, error: `点赞失败：${error?.message ?? error}` }, 502);
      }
      return true;
    }

    // ── POST /api/socialV2/qzone-comment（评论）────────────────────────────
    if (pathname === '/api/socialV2/qzone-comment') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const tid = String(body.tid ?? body.key2 ?? '').trim();
      const targetUin = String(body.targetUin ?? body.uin ?? '').trim();
      const content = String(body.content ?? '').trim();
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (!tid) { sendJson({ ok: false, error: 'tid 不能为空（来自 qzone-feeds 的 tid）' }, 400); return true; }
      if (!content) { sendJson({ ok: false, error: 'content 不能为空（评论内容）' }, 400); return true; }
      if (content.length > 120) { sendJson({ ok: false, error: 'content 太长（上限 120 字）' }, 400); return true; }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken) {
        if (!agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
        if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      }
      // 每天最多 20 条评论，避免被当成刷屏
      const today = todayStr();
      if (!globalThis.__qzoneCommentDaily || globalThis.__qzoneCommentDaily.date !== today) globalThis.__qzoneCommentDaily = { date: today, count: 0 };
      if (globalThis.__qzoneCommentDaily.count >= 20) { sendJson({ ok: false, error: '今天评论够 20 条了，明天再说' }, 429); return true; }
      try {
        const payload = { tid, content };
        if (targetUin && /^\d+$/.test(targetUin)) payload.target_uin = Number(targetUin);
        const res = await onebotHttpAction('comment_qzone', payload, { timeoutMs: 25000 });
        if (res && (res.status === 'failed' || (res.retcode && res.retcode !== 0))) {
          sendJson({ ok: false, error: String(res.wording || res.message || '评论失败') }, 502);
          return true;
        }
        globalThis.__qzoneCommentDaily.count += 1;
        log(`[qzone] 已评论 tid=${tid} uin=${targetUin || '-'}：${content.slice(0, 40)}（今日第 ${globalThis.__qzoneCommentDaily.count} 条）`);
        appendActivity(`${key} 空间评论：${content.slice(0, 40)}`);
        sendJson({
          ok: true, tid, targetUin: targetUin || null, content,
          todayCount: globalThis.__qzoneCommentDaily.count,
          note: `已在空间回复：${content.slice(0, 30)}`,
        });
      } catch (error) {
        sendJson({ ok: false, error: `评论失败：${error?.message ?? error}` }, 502);
      }
      return true;
    }

    return false;
  };
}

export default createSocialV2QzoneHandler;
