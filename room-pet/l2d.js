// Live2D 版：pixi-live2d-display + Cubism 4
// 模型缺失时优雅降级（只显示背景 + 气泡）
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const stage = $('stage');
  const bubble = $('bubble');
  const bubbleText = $('bubbleText');
  const clockEl = $('clock');
  const moodEl = $('mood');
  const holder = $('l2dCanvas');

  const MODEL_URL = 'models/Hiyori/Hiyori.model3.json';

  let model = null;
  let mood = 6;
  let state = 'idle';
  let talking = false;
  let talkTimer = null;
  let bubbleTimer = null;

  const lines = {
    idle: ['……今天也这么晚啊。', '窗外好像在飘雪。', '台灯有点暖。', '你忙你的，我不吵你。'],
    petting: ['唔……舒服。', '再摸一会儿嘛。', '嘿嘿。'],
    annoyed: ['别捏了……', '再捏我要生气了。'],
    crying: ['呜……你欺负人。'],
    hugging: ['抱抱……暖和。'],
    feeding: ['啊——', '嗯，好吃。'],
    study: ['一起看书吧。'],
  };

  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  function say(text, hold) {
    if (!text) return;
    bubbleText.textContent = text;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), hold || Math.max(2600, text.length * 170));
  }

  function setMood(v) {
    mood = Math.max(0, Math.min(10, v));
    const shown = Math.round(mood * 10) / 10;
    moodEl.innerHTML = `心情 <b>${shown}</b>/10`;
  }

  function layoutModel(m, app) {
    const W = app.renderer.width / app.renderer.resolution;
    const H = app.renderer.height / app.renderer.resolution;
    const scale = (H * 0.9) / m.height;
    m.anchor.set(0.5, 1);
    m.scale.set(scale);
    m.position.set(W / 2, H - 6);
  }

  // ---------------- 模型
  async function initModel() {
    if (typeof PIXI === 'undefined' || !PIXI.live2d) {
      console.warn('pixi / pixi-live2d-display 未加载');
      return null;
    }
    const W = holder.clientWidth || window.innerWidth;
    const H = holder.clientHeight || window.innerHeight;
    const app = new PIXI.Application({
      width: W,
      height: H,
      transparent: true,
      antialias: true,
      autoStart: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    holder.appendChild(app.view);
    app.view.style.width = W + 'px';
    app.view.style.height = H + 'px';
    window.addEventListener('resize', () => {
      app.renderer.resize(holder.clientWidth, holder.clientHeight);
      if (model) layoutModel(model, app);
    });

    const m = await PIXI.live2d.Live2DModel.from(MODEL_URL, { autoInteract: false });
    app.stage.addChild(m);

    layoutModel(m, app);

    m.internalModel.motionManager.expressionManager = null;
    // 自动眨眼 + 呼吸已经由 runtime 处理
    m.motion('Idle');
    return m;
  }

  // ---------------- 动作
  function play(group, index) {
    if (!model) return;
    try {
      model.motion(group, index);
    } catch (e) {
      console.warn('motion 失败', e);
    }
  }

  function setState(next) {
    state = next;
    stage.dataset.state = next;
    if (!model) return;
    if (next === 'petting' || next === 'hugging' || next === 'feeding' || next === 'annoyed') {
      play('TapBody', 0);
    } else if (next === 'idle') {
      play('Idle');
    }
  }

  // 说话：驱动口型参数
  function startTalk(ms) {
    if (!model) return;
    talking = true;
    clearInterval(talkTimer);
    talkTimer = setInterval(() => {
      try {
        const core = model.internalModel.coreModel;
        const v = talking ? (0.15 + Math.random() * 0.55) : 0;
        core.setParameterValueById('ParamMouthOpenY', v);
      } catch (e) {}
    }, 90);
    setTimeout(() => {
      talking = false;
      clearInterval(talkTimer);
      try {
        model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', 0);
      } catch (e) {}
    }, ms || 1800);
  }

  // ---------------- 鼠标：视线跟随 + 点击
  document.addEventListener('mousemove', e => {
    if (!model) return;
    try { model.focus(e.clientX, e.clientY); } catch (err) {}
  });

  document.addEventListener('click', e => {
    if (!model) return;
    const r = holder.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    pet();
  });

  function pet() {
    setState('petting');
    play('TapBody', 0);
    say(pick(lines.petting), 1600);
    setMood(mood + 0.4);
    try { window.roomStats && roomStats.pet(); } catch (e) {}
    startTalk(1200);
    setTimeout(() => { if (state === 'petting') setState('idle'); }, 1600);
  }

  // ---------------- 按钮
  document.querySelector('.actions').addEventListener('click', e => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === 'hug') {
      setState('hugging'); say(pick(lines.hugging), 2400); startTalk(1600);
      setMood(mood + 1.2);
      try { window.roomStats && roomStats.hug(); } catch (e) {}
      setTimeout(() => setState('idle'), 2400);
    }
    if (act === 'feed') {
      setState('feeding'); say(pick(lines.feeding), 2000); startTalk(1400);
      setMood(mood + 1);
      try { window.roomStats && roomStats.feed(); } catch (e) {}
      setTimeout(() => setState('idle'), 2400);
    }
    if (act === 'study') {
      setState('study'); say(pick(lines.study), 2000);
      startTalk(1200);
      setTimeout(() => setState('idle'), 3000);
    }
    if (act === 'chat') {
      const box = $('chatBox');
      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) $('chatInput').focus();
    }
  });

  // ---------------- 聊天
  function localReply(text) {
    if (/累|困|睡/.test(text)) return '那就早点休息吧，我在这儿。';
    if (/吃|饭|饿/.test(text)) return '我还不饿……你要不要吃点东西？';
    if (/你好|在吗/.test(text)) return '在的。深夜好。';
    if (/歌|音乐/.test(text)) return '想听安静一点的，还是热闹一点的？';
    if (/抱|摸/.test(text)) return '嘿嘿……可以再摸一下。';
    return '嗯，我记下了。';
  }

  function sendChat() {
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    say('嗯……' + text.slice(0, 18), 1500);
    startTalk(900);
    setTimeout(() => {
      const reply = localReply(text);
      say(reply, 4200);
      startTalk(1800);
      setMood(mood + 0.3);
    }, 700);
  }

  $('chatSend').addEventListener('click', sendChat);
  $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  // ---------------- 时钟
  function tickClock() {
    const d = new Date();
    clockEl.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  setInterval(tickClock, 1000);
  tickClock();

  // ---------------- 启动
  setMood(mood);
  initModel().then(m => {
    model = m;
    if (m) {
      say('……你来了。', 2600);
    } else {
      say('模型没加载成功，先只显示背景。', 4000);
    }
  }).catch(err => {
    console.error(err);
    say('模型加载失败：' + (err && err.message ? err.message : err), 5000);
  });


// ---------------- TTS：真实语音 + 音量驱动口型
let audioCtx = null, analyser = null, audioEl = null, audioPlaying = false;

function ensureAudio() {
  if (audioCtx) return;
  audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous';
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  const src = audioCtx.createMediaElementSource(audioEl);
  src.connect(analyser);
  analyser.connect(audioCtx.destination);
}

function mouthFromAudio() {
  if (!audioPlaying || !analyser) return null;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  const rms = Math.sqrt(sum / buf.length);
  return Math.min(1, Math.max(0, (rms - 0.008) * 7));   // 鲸伴同款公式
}

let mouthEnv = 0, silentSince = 0;
function mouthLoop(now) {
  if (model && audioPlaying) {
    const v = mouthFromAudio();
    if (v !== null && v > 0.02) { mouthEnv = v; silentSince = 0; }
    else if (!silentSince) silentSince = now;
    else if (now - silentSince > 400) mouthEnv *= 0.85;
    const target = Math.max(mouthEnv, 0.04);
    const k = target > mouthEnv ? 0.6 : 0.12;
    mouthEnv += (target - mouthEnv) * k;
    try { model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', mouthEnv); } catch (_) {}
  }
  requestAnimationFrame(mouthLoop);
}
requestAnimationFrame(mouthLoop);

async function speakAudio(text) {
  if (!text) return false;
  ensureAudio();
  try {
    // 打断：正在说话就先停掉，换成新的一句
    try { audioEl.pause(); audioEl.currentTime = 0; } catch (_) {}
    const r = await fetch('/tts?stream=1&text=' + encodeURIComponent(text));
    if (!r.ok) return false;
    audioEl.src = URL.createObjectURL(await r.blob());   // 流式响应同样能吃成 blob 再播
    await audioCtx.resume();
    audioPlaying = true;
    audioEl.onended = () => { audioPlaying = false; mouthEnv = 0; };
    await audioEl.play();
    return true;
  } catch (e) {
    audioPlaying = false;
    return false;
  }
}
window.roomPetSpeak = speakAudio;

  // ---------------- 外部状态（qq-bridge / 脚本推送）
  function connectState() {
    if (!window.EventSource) return;
    const es = new EventSource('/events');
    es.onmessage = e => {
      let d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      const st = d.state || 'idle';
      document.title = 'SSE:' + st;
      if (d.text) say(d.text, Math.max(2500, d.text.length * 170));
      if (st === 'speaking') { if (d.text) speakAudio(d.text).then(ok => { if (!ok) startTalk(2200); }); else startTalk(2200); }
      else if (st === 'thinking') { play('Idle', 0); }
      else if (st === 'sleep') { setState('idle'); stage.dataset.sleep = '1'; }
      else { stage.dataset.sleep = ''; setState(st === 'listening' ? 'petting' : 'idle'); }
    };
    es.onerror = () => { es.close(); setTimeout(connectState, 2000); };
  }
  connectState();

  // 对外接口
  window.roomPet = {
    say, setMood,
    setState,
    startTalk,
    get state() { return state; },
    get mood() { return mood; },
    get model() { return model; },
  };
})();
