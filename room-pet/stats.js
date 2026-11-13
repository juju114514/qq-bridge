// 数值系统：饱食度 / 精力 / 亲密度
// 存 localStorage，带时间衰减
(() => {
  'use strict';

  const KEY = 'roomPet.stats.v1';
  const DECAY = {
    fullness: 100 / (6 * 60 * 60),   // 6 小时掉完
    energy: 100 / (8 * 60 * 60),     // 8 小时掉完
  };

  const defaults = { fullness: 70, energy: 75, affection: 20, ts: Date.now() };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { ...defaults, ts: Date.now() };
      const s = JSON.parse(raw);
      return { ...defaults, ...s, ts: s.ts || Date.now() };
    } catch (_) {
      return { ...defaults, ts: Date.now() };
    }
  }

  function save(s) {
    s.ts = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {}
  }

  let st = load();

  function decay() {
    const now = Date.now();
    const hours = Math.max(0, (now - st.ts) / 3600000);
    if (hours <= 0) return;
    st.fullness = clamp(st.fullness - DECAY.fullness * hours);
    st.energy = clamp(st.energy - DECAY.energy * hours);
    st.ts = now;
  }

  function clamp(v) { return Math.max(0, Math.min(100, v)); }

  function apply(delta) {
    for (const k of ['fullness', 'energy', 'affection']) {
      if (typeof delta[k] === 'number') st[k] = clamp(st[k] + delta[k]);
    }
    save(st);
    render();
    return st;
  }

  // ---------------- UI
  let barEl = null;
  function ensureUI() {
    if (barEl) return barEl;
    barEl = document.createElement('div');
    barEl.className = 'stats';
    barEl.innerHTML = `
      <div class="stat"><span>饱食</span><i><b style="width:0%"></b></i></div>
      <div class="stat"><span>精力</span><i><b style="width:0%"></b></i></div>
      <div class="stat"><span>亲密</span><i><b style="width:0%"></b></i></div>
    `;
    document.body.appendChild(barEl);
    return barEl;
  }

  function render() {
    const el = ensureUI();
    const fill = el.querySelectorAll('.stat b');
    if (fill.length === 3) {
      fill[0].style.width = st.fullness + '%';
      fill[1].style.width = st.energy + '%';
      fill[2].style.width = st.affection + '%';
    }
    el.dataset.low = (st.fullness < 20 || st.energy < 20) ? '1' : '0';
  }

  // 每 30 秒衰减一次
  setInterval(() => { decay(); save(st); render(); }, 30000);

  window.roomStats = {
    get value() { decay(); return { ...st }; },
    apply,
    // 行为快捷方式
    feed(n = 25) { return apply({ fullness: n, affection: 2 }); },
    pet() { return apply({ affection: 2 }); },
    hug() { return apply({ affection: 5 }); },
    study(min) { return apply({ energy: -Math.min(30, min * 0.6), affection: 3 }); },
    sleep(hours) { return apply({ energy: Math.min(60, hours * 12), fullness: -6 }); },
    reset() { st = { ...defaults, ts: Date.now() }; save(st); render(); },
  };

  decay();
  render();
})();
