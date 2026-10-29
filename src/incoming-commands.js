// handleIncoming 里的「桥接直接执行的命令」：公开命令 + 首次人设引导。
//
// 为什么抽出来：
//   handleIncoming 720 行里，这一块占了近 200 行，但它是**纯命令分发**——
//   不碰模型、不碰发送链，只调 sendToQQ 和几个状态读写，是最适合先搬的一段。
//
// 语义约定：返回 true = 命令已处理（调用方直接 return）；
//           返回 false = 不是命令，继续往下走（进模型）。
//
// 依赖全部注入，可离线测（见 scripts/test-incoming-commands.mjs）。

export function createIncomingCommands(deps = {}) {
  const {
    log = () => {},
    fs, path,
    getCfg,
    sendToQQ,
    sendGuideTemplate,
    SLANG_FILE, STATE_DIR,
    listRoles, roleName, resolveRoleName, sanitizeRoleName, validateRoleContent,
    writeRoleContent, writeRoleState, readRoleState, readRoleStateForKey, writeRoleStateForKey,
    readJsonSafe, atomicWriteJson
  } = deps;

  async function handlePublic(ctx = {}) {
    const { key, kind, isOwner, plainContent } = ctx;
    const cfg = getCfg();
    // 公开命令：任何人都能用，桥接直接回固定文本（不经过模型，零 token）
    const cmdText = plainContent.trim().replace(/^(@\S+\s*)+/, '').trim();

    // /攻略 游戏名 [主题] —— 按模板直出攻略卡片（零 token）
    const guideCmd = /^\/?(?:攻略|查攻略|怎么打)\s+(.{1,20})$/i.exec(cmdText);
    if (guideCmd) {
      const parts = guideCmd[1].trim().split(/\s+/);
      const wanted = parts[0] || '';
      const topicArg = parts.slice(1).join(' ');
      const r = await sendGuideTemplate(key, wanted, topicArg);
      if (r.ok && r.found) {
        await sendToQQ(key, `给你翻了份《${r.game}》${r.topic ? '「' + r.topic + '」' : ''}，点开看`);
      } else if (r.ok) {
        await sendToQQ(key, `本地还没有《${wanted}》的攻略，@我 说「${wanted} 攻略」我去联网整理一份`);
      } else {
        await sendToQQ(key, `攻略发送失败：${r.error || '未知原因'}`);
      }
      return true;
    }

    // /梗 xxx —— 查群黑话库（零 token，秒回）
    const slangCmd = /^\/?(?:梗|什么梗|这梗)\s+(.+)$/i.exec(cmdText);
    if (slangCmd) {
      const q = slangCmd[1].trim().slice(0, 20);
      let entries = [];
      try { entries = JSON.parse(fs.readFileSync(SLANG_FILE, 'utf8')); } catch { entries = []; }
      if (!Array.isArray(entries)) entries = [];
      const hits = entries
        .filter((e) => { const c = String(e.content || ''); return c && (c.includes(q) || q.includes(c)); })
        .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
        .slice(0, 2);
      if (!hits.length) {
        await sendToQQ(key, `没听过「${q}」，可能是新梗。想知道就 @我 问，我去查。`);
      } else {
        const lines = hits.map((e) => {
          const word = String(e.content || '');
          const meaning = String(e.meaning || '').trim();
          const usage = String(e.usage || '').trim();
          if (!meaning) return `「${word}」群里有这个词（出现 ${e.count || 1} 次），但还没人给它下定义`;
          return `「${word}」${meaning.slice(0, 120)}${usage ? `\n用法：${usage.slice(0, 80)}` : ''}`;
        });
        await sendToQQ(key, lines.join('\n'));
      }
      return true;
    }

    // /指令 —— 能力清单
    if (/^\/?(指令|帮助|菜单|功能|help|commands?)$/i.test(cmdText)) {
      const helpLines = [
        '【小鲸鱼 · 指令】',
        '直接说话就行，不用记格式：',
        '· 聊天接梗 —— @我，或叫「小鲸鱼」「大肥鱼」',
        '· 表情包 —— 「来张表情包」「斗图」',
        '· 语音 —— 「说句话听听」',
        '· 唱歌 —— 「你唱一个」「用你声音唱 晴天」',
        '· 点歌 —— 「来首 孤勇者」；说「母带」「无损」升音质，说「整首」发全曲',
        '· 攻略 —— 「XX 怎么打」我整理成一份发你；也可以 /攻略 忍3 兑换码',
        '· 点赞 —— 「给老板点个赞」',
        '· 看图 —— 直接发图，我能说出图里是什么',
        '· 搜索 —— 问实时/网上的事，我会联网查',
        '· 查梗 —— /梗 丝竹，查群里黑话的意思',
        '· 潜水 —— 不理我就自己潜，@我立刻醒',
      ];
      {
        const roleList = listRoles();
        const curRole = readRoleStateForKey(key).role;
        if (roleList.length) {
          helpLines.push(
            `· 人设 —— 当前会话用的是「${curRole || '默认'}」；/role 看全部、/role 名字 切换（管理员）`,
            '  私聊和群聊的人设互相独立，各自锁定',
            `  现有：${roleList.join('、')}`,
          );
        }
      }
      if (isOwner && kind === 'private') {
        helpLines.push(
          '———',
          '/指令  这个列表',
          '/status  运行状态',
          '/reset /new  重开会话',
          '/active /quiet /silent  活跃度',
          '/like QQ号 [次数]  给某人点赞',
          '/song 歌名[|母带|无损][|整首]  直接点歌',
        );
      }
      await sendToQQ(key, helpLines.join('\n'));
      return true;
    }

    // /role（不带参数）—— 列出可用人设，顺便提示怎么切换
    if (/^\/role\s*$/i.test(cmdText)) {
      const roles = listRoles();
      const rs = readRoleState();
      const cur = rs.role ? `「${roleName(rs.role)}」` : '默认人格（未指定角色卡）';
      const lines = [
        `当前人设：${cur}`,
        `可用角色卡（${roles.length} 张）：`,
        ...roles.map((r) => `· ${r}`),
        '',
        '切换：/role 名字      恢复默认：/role off',
        '新建：把你想要的性格/说话风格发我，我写成一张卡',
      ];
      await sendToQQ(key, lines.join('\n'));
      return true;
    }

    // 首次使用：让人选人设（默认 / 新建 / 不用），避免拿到别人的人设
    {
      const firstRun = cfg.role?.firstRunChoice !== false;
      const setupFile = path.join(STATE_DIR, 'role-setup.json');
      let setup = readJsonSafe(setupFile, { done: false, pending: null });
      if (firstRun && isOwner && kind === 'private' && !setup.done) {
        const t = cmdText.trim();
        const hasPendingDescribe = setup.pending === 'describe';

        if (hasPendingDescribe && t && !/^[123]$/.test(t)) {
          // 用用户描述生成一张角色卡
          const desc = t.slice(0, 1200);
          const base = desc.split(/[，,。.！!？?\s]/).find((x) => x && x.length >= 2) || '自定义角色';
          const name = sanitizeRoleName(base).slice(0, 8) || '自定义角色';
          const card = [
            `# ${name}`,
            '',
            '## 你是谁',
            desc,
            '',
            '## 说话方式',
            '- 保持上面描述的语气与称呼，别退回客服腔',
            '- 回复简短自然，像群友聊天，不写作文',
            '',
            '## 互动规则',
            '- 别人 @ 你或直接提问时才回复',
            '- 不确定的事就说不确定，别编',
          ].join('\n');
          try {
            const content = validateRoleContent(card);
            if (listRoles().includes(name)) {
              await sendToQQ(key, `已经有「${name}」这张卡了，换个名字或直接 /role ${name} 用它。`);
            } else {
              writeRoleContent(name, content);
              writeRoleState(name, 'active');
              atomicWriteJson(setupFile, { done: true, pending: null, role: name });
              await sendToQQ(key, `角色卡「${name}」已创建并启用（roles/${name}.md）。\n想改就编辑那个文件，或者 /role off 恢复默认。`);
              log(`[role-setup] 新建角色卡 ${name}`);
            }
          } catch (error) {
            await sendToQQ(key, `建卡失败：${error?.message ?? error}`);
          }
          return true;
        }

        const choice = /^1$|^默认/.test(t) ? '1' : /^2$|^新建/.test(t) ? '2' : /^3$|^不用|^关闭/.test(t) ? '3' : null;
        if (choice === '1') {
          // 解析顺序：配置里写的名字（可能是 `小鲸鱼` 这种不带后缀的）→ 按前缀找小鲸鱼 → 第一张卡。
          // ⚠️ 旧写法是 `listRoles().includes('小鲸鱼')`，而真实文件名是
          // `小鲸鱼（已测试）.md` ⇒ includes 永远 false，直接掉到 `listRoles()[0]`，
          // 也就是排序最靠前的 `傲娇助手（无测试）`（198 字节的占位卡）。
          // 用 resolveRoleName 走「精确 → 前缀 → 包含」，改名/加后缀都不再影响默认人设。
          const configured = resolveRoleName(cfg.role?.defaultName);
          if (cfg.role?.defaultName && !configured) {
            log(`⚠️ 配置的默认人设「${cfg.role.defaultName}」找不到对应角色卡，已改用可用卡片`);
          }
          const def = configured || resolveRoleName('小鲸鱼') || listRoles()[0] || null;
          if (def) writeRoleStateForKey(key, def, 'active'); else writeRoleStateForKey(key, null, 'active');
          atomicWriteJson(setupFile, { done: true, pending: null, role: def });
          await sendToQQ(key, `好，用默认人设${def ? `「${def}」` : ''}。随时 /role 换。`);
          return true;
        }
        if (choice === '2') {
          atomicWriteJson(setupFile, { done: false, pending: 'describe' });
          await sendToQQ(key, '发我想要的人设吧：性格、说话风格、怎么称呼对方，随便写几句就行。');
          return true;
        }
        if (choice === '3') {
          writeRoleStateForKey(key, null, 'active');
          atomicWriteJson(setupFile, { done: true, pending: null, role: null });
          await sendToQQ(key, '好，不用角色卡，我按默认人格说话。以后想加用 /role 新建。');
          return true;
        }

        // 还没选：把菜单发出去，并停在这里等回复
        await sendToQQ(key, [
          '第一次用，先定个人设吧（回数字就行）：',
          '1. 用默认人设（小鲸鱼/大肥鱼）',
          '2. 新建一个（你说性格，我写卡）',
          '3. 不用人设，按默认说话',
        ].join('\n'));
        atomicWriteJson(setupFile, { done: false, pending: 'choose' });
        return true;
      }
    }
    return false;
  }

  return { handlePublic };
}
