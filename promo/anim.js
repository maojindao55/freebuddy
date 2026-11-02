(() => {
  const T = 16;
  const FADE = 0.35;
  const AGENTS = [
    ['openai.webp', 'Codex'], ['claude.webp', 'ClaudeCode'], ['cursor.webp', 'Cursor'],
    ['devin.webp', 'Devin'], ['cline.webp', 'Cline'], ['gemini.webp', 'Antigravity'],
    ['pi.svg', 'Pi'], ['deepseek.webp', 'DeepSeek'], ['zhipu.webp', 'ZCode'],
    ['grok.webp', 'Grok'], ['kimi.webp', 'Kimi'], ['qoder.webp', 'Qoder'],
    ['codebuddy.webp', 'CodeBuddy'], ['opencode.webp', 'OpenCode'],
  ];

  const stage = document.getElementById('stage');
  const prog = document.getElementById('prog');
  const iconsEl = document.getElementById('icons');

  AGENTS.forEach(([file, name], i) => {
    const d = document.createElement('div');
    d.className = 'ic';
    d.dataset.in = (0.45 + i * 0.07).toFixed(2);
    d.dataset.fx = 'fly';
    d.dataset.dur = '0.7';
    d.dataset.idx = String(i);
    d.innerHTML = `<img src="assets/agents/${file}" alt="" /><span>${name}</span>`;
    iconsEl.appendChild(d);
  });

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  const easeBack = (p) => { const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };

  const scenes = [...document.querySelectorAll('.scene')].map((el) => ({
    el,
    start: +el.dataset.start,
    end: +el.dataset.end,
    items: [...el.querySelectorAll('[data-in]')],
  }));

  function applyItem(el, local) {
    const p = clamp((local - +el.dataset.in) / (+el.dataset.dur || 0.6));
    const e = easeOut(p);
    const s = el.style;
    if (el.dataset.count) el.textContent = String(Math.round(+el.dataset.count * e));
    switch (el.dataset.fx || 'up') {
      case 'none': break;
      case 'zoom':
        s.opacity = clamp(p * 2);
        s.transform = `scale(${0.4 + 0.6 * easeBack(p)})`;
        break;
      case 'left':
        s.opacity = e;
        s.transform = `translateX(${(1 - e) * -48}px)`;
        break;
      case 'rise': {
        const run = +el.dataset.run, done = +el.dataset.done;
        const q = clamp((local - run) / (done - run));
        const on = clamp((local - run) / 0.15) * (1 - clamp((local - done) / 0.35));
        const pulse = 0.5 + 0.5 * Math.sin((local - run) * Math.PI * 6);
        const dp = clamp((local - done) / 0.3);
        s.opacity = e;
        s.filter = p < 1 ? `blur(${(1 - e) * 10}px)` : 'none';
        s.transform = `translateY(${(1 - e) * 28 - 8 * on}px) scale(${0.96 + 0.04 * e + 0.02 * on})`;
        s.borderColor = local >= run ? `rgba(16,185,129,${0.25 + 0.55 * on + 0.2 * dp})` : '';
        s.boxShadow = on > 0 ? `0 0 0 ${3 * on}px rgba(16,185,129,${0.12 + 0.14 * pulse * on}), 0 24px 60px -22px rgba(4,120,87,${0.55 * on})` : '';
        const bar = el.querySelector('.bar span');
        if (bar) bar.style.transform = `scaleX(${easeOut(q)})`;
        const ok = el.querySelector('.ok');
        if (ok) { ok.style.opacity = clamp(dp * 2); ok.style.transform = `scale(${easeBack(dp)})`; }
        break;
      }
      case 'pkt':
        s.left = `${easeInOut(p) * 100}%`;
        s.opacity = p > 0 && p < 1 ? Math.sin(Math.PI * p) : 0;
        break;
      case 'glow': {
        const nodes = [...el.parentElement.querySelectorAll('.node')];
        const cx = nodes.map((n) => n.offsetLeft + n.offsetWidth / 2);
        let x = cx[0];
        for (let i = 1; i < nodes.length; i++) {
          const a = +nodes[i - 1].dataset.done, b = +nodes[i].dataset.run;
          x += (cx[i] - cx[i - 1]) * easeInOut(clamp((local - a) / (b - a)));
        }
        const fin = easeInOut(clamp((local - +nodes[nodes.length - 1].dataset.done) / 0.5));
        x += ((cx[0] + cx[cx.length - 1]) / 2 - x) * fin;
        s.opacity = clamp((local - 0.3) / 0.4) * (1 - 0.45 * fin);
        s.transform = `translateX(${x}px) scale(${1 + 0.8 * fin})`;
        break;
      }
      case 'grow':
        s.transform = `scaleX(${e})`;
        break;
      case 'fly': {
        const a = (+el.dataset.idx / AGENTS.length) * Math.PI * 2;
        const r = (1 - e) * 640;
        s.opacity = clamp(p * 1.6);
        s.transform = `translate(${Math.cos(a) * r}px, ${Math.sin(a) * r}px) rotate(${(1 - e) * -200}deg) scale(${0.5 + 0.5 * easeBack(p)})`;
        break;
      }
      default:
        s.opacity = e;
        s.transform = `translateY(${(1 - e) * 36}px)`;
    }
  }

  function render(t) {
    t = ((t % T) + T) % T;
    for (const sc of scenes) {
      const on = t >= sc.start && t < sc.end;
      sc.el.style.visibility = on ? 'visible' : 'hidden';
      if (!on) continue;
      const local = t - sc.start;
      const fin = sc.start === 0 ? 1 : clamp(local / FADE);
      const fout = clamp((sc.end - t) / FADE);
      sc.el.style.opacity = Math.min(fin, fout);
      sc.el.style.transform = `scale(${1 + (1 - fout) * 0.04})`;
      sc.items.forEach((el) => applyItem(el, local));
    }
    prog.style.transform = `scaleX(${t / T})`;
    if (window.GL) window.GL.render(t);
  }

  const params = new URLSearchParams(location.search);
  const EXPORT = params.has('export');

  if (window.GL) window.GL.init(document.getElementById('stage'), scenes.map((s) => ({ start: s.start, end: s.end, shape: s.el.dataset.shape || 'sphere' })));
  window.__ready = Promise.all([
    window.GL && window.GL.ready,
    document.fonts.ready,
    ...[...document.images].map((img) => (img.complete ? 0 : new Promise((r) => { img.onload = img.onerror = r; }))),
  ]);
  window.render = render;
  window.PROMO = { T };

  if (EXPORT) {
    document.body.classList.add('export');
    render(0);
    return;
  }

  const fit = () => {
    const k = Math.min(innerWidth / 1600, innerHeight / 900);
    stage.style.transform = `scale(${k})`;
  };
  addEventListener('resize', fit);
  fit();

  let paused = false;
  let offset = params.has('t') ? +params.get('t') : 0;
  let t0 = performance.now();
  const cur = () => (paused ? offset : offset + (performance.now() - t0) / 1000);

  addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      offset = cur();
      t0 = performance.now();
      paused = !paused;
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      offset = cur() + (e.key === 'ArrowRight' ? 1 : -1);
      t0 = performance.now();
    }
    if (paused) render(offset);
  });

  const loop = () => {
    if (!paused) render(cur());
    requestAnimationFrame(loop);
  };
  render(offset);
  window.__ready.then(() => {
    t0 = performance.now();
    requestAnimationFrame(loop);
  });
})();
