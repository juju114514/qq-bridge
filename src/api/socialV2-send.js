/**
 * socialV2 —— C 批（安全子集）：语音合成类
 *
 *   POST /api/socialV2/say    现场 TTS（调 speak.ps1）
 *   POST /api/socialV2/sing   唱歌（调 sing.ps1；可指定歌名自动取词）
 *
 * 这两个端点**不经过 sendMessagesV2**：它们 spawn 外部 PowerShell 脚本，
 * 脚本自己发语音条。所以这里没有发送额度记账，只有守卫 + 启动子进程。
 *
 * 校验顺序与原实现一致（注意 say/sing 的顺序和别的端点不同）：
 *   reserved2 → key 空 → 文本空 → agent token → 工具开关 → 会话白名单 → 静默拦截
 */

import os from 'node:os';
import { spawn } from 'node:child_process';

export function createSocialV2SendHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    getMode,
    agentTokenOk,
    v2ToolEnabled,
    v2SessionAllowed,
    shouldBlockSilentReply,
    fs,
    path,
    resolveRuntimeDir,
  } = deps;

  return async function handleSocialV2Send(req, url) {
    if (req.method !== 'POST') return false;
    const { pathname } = url;

    // ── POST /api/socialV2/say ─────────────────────────────────────────────
    if (pathname === '/api/socialV2/say') {
      const body = await readBody();
      const agentToken = req.headers['x-agent-token'];
      const token = String(body.token ?? agentToken ?? '').trim();
      const key = String(body.key ?? '').trim();
      const text = String(body.text ?? '').trim().slice(0, 120);
      const mood = String(body.mood ?? '正常').trim();
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (!text) { sendJson({ ok: false, error: 'text 不能为空（要说的话）' }, 400); return true; }
      if (agentToken) {
        if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
        if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_say' }, 403); return true; }
        if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      }
      if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }

      const sayScript = process.env.QQBOT_SAY_SCRIPT || path.join(resolveRuntimeDir('QQBOT_TOOLS', 'tools', ''), 'speak.ps1');
      if (!fs.existsSync(sayScript)) {
        sendJson({ ok: false, error: `说话脚本不存在：${sayScript}（可用 QQBOT_SAY_SCRIPT 或 config.paths.tools 指定）` }, 500);
        return true;
      }
      const textFile = path.join(os.tmpdir(), `qq-say-${Date.now()}.txt`);
      try {
        fs.writeFileSync(textFile, text, 'utf8');
      } catch (error) {
        sendJson({ ok: false, error: `写文本文件失败：${error?.message ?? error}` }, 500);
        return true;
      }
      try {
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sayScript, '-TextFile', textFile, '-Mood', mood, '-Target', key], { windowsHide: true, stdio: 'ignore' });
        child.on('exit', (code) => log(`[say] ${key} 结束 code=${code}（${mood}）`));
        child.on('error', (error) => log(`[say] ${key} 失败：${error?.message ?? error}`));
        log(`[say] ${key} 开始合成（${mood}｜${text.slice(0, 40)}）`);
        sendJson({ ok: true, key, text, mood, note: '正在合成，约 3 秒后以语音条发出' });
      } catch (error) {
        sendJson({ ok: false, error: `启动合成失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    // ── POST /api/socialV2/sing ────────────────────────────────────────────
    if (pathname === '/api/socialV2/sing') {
      const body = await readBody();
      const agentToken = req.headers['x-agent-token'];
      const token = String(body.token ?? agentToken ?? '').trim();
      const key = String(body.key ?? '').trim();
      const lyric = String(body.lyric ?? '').trim().slice(0, 40);
      const songName = String(body.song ?? '').trim().slice(0, 60);
      const style = String(body.style ?? '儿歌').trim();
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (!lyric && !songName) { sendJson({ ok: false, error: 'lyric 或 song 至少给一个（song=唱某首歌，自动取歌词）' }, 400); return true; }
      if (agentToken) {
        if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
        if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_sing' }, 403); return true; }
        if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      }
      if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }

      const singScript = process.env.QQBOT_SING_SCRIPT || path.join(resolveRuntimeDir('QQBOT_TOOLS', 'tools', ''), 'sing.ps1');
      if (!fs.existsSync(singScript)) {
        sendJson({ ok: false, error: `唱歌脚本不存在：${singScript}（可用 QQBOT_SING_SCRIPT 或 config.paths.tools 指定）` }, 500);
        return true;
      }
      const argFile = path.join(os.tmpdir(), `qq-sing-${Date.now()}.txt`);
      try {
        fs.writeFileSync(argFile, songName || lyric, 'utf8');
      } catch (error) {
        sendJson({ ok: false, error: `写临时文件失败：${error?.message ?? error}` }, 500);
        return true;
      }
      const singArgs = songName
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', singScript, '-SongFile', argFile, '-Style', style, '-Target', key]
        : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', singScript, '-LyricFile', argFile, '-Style', style, '-Target', key];
      const label = songName ? `唱《${songName}》` : lyric;
      try {
        const child = spawn('powershell.exe', singArgs, { windowsHide: true, stdio: 'ignore' });
        child.on('exit', (code) => log(`[sing] ${key} 生成结束 code=${code}（${style}｜${label}）`));
        child.on('error', (error) => log(`[sing] ${key} 生成失败：${error?.message ?? error}`));
        log(`[sing] ${key} 开始合成（${style}｜${label}）`);
        sendJson({
          ok: true,
          key,
          lyric,
          song: songName,
          style,
          note: songName ? '正在取歌词并合成，约 10~25 秒后以语音条发出' : '正在合成，几秒后以语音条发出',
        });
      } catch (error) {
        sendJson({ ok: false, error: `启动合成失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    return false;
  };
}

export default createSocialV2SendHandler;
