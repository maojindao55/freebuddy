import * as THREE from 'three';
import * as CINE from './cine.src.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// Rasterize via canvas so SVGs without intrinsic size (e.g. pi.svg) still upload.
const raster = (src, n = 1024) => new Promise((ok, no) => { const im = new Image(); im.onload = () => { const c = document.createElement("canvas"); c.width = c.height = n; c.getContext("2d").drawImage(im, 0, 0, n, n); ok(new THREE.CanvasTexture(c)); }; im.onerror = no; im.src = src; });


// Foreground 3D layer: every tracked <img> becomes a beveled glass tile that mirrors the DOM box.
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const spring = (p) => (p >= 1 ? 1 : 1 - Math.exp(-5.5 * p) * Math.cos(8.5 * p));
let R, S, C, stage, key, W, H, VW, VH, tiles = [], scenes = [];

function tileGeo(r = 0.27) {
  const s = new THREE.Shape(), h = 0.5;
  s.moveTo(-h + r, -h); s.lineTo(h - r, -h); s.quadraticCurveTo(h, -h, h, -h + r);
  s.lineTo(h, h - r); s.quadraticCurveTo(h, h, h - r, h); s.lineTo(-h + r, h);
  s.quadraticCurveTo(-h, h, -h, h - r); s.lineTo(-h, -h + r); s.quadraticCurveTo(-h, -h, -h + r, -h);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.045, bevelSize: 0.03, bevelSegments: 5, curveSegments: 14 });
  g.center(); return g;
}

function init(st, list) {
  stage = st; scenes = list; W = st.clientWidth; H = st.clientHeight;
  R = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  R.setPixelRatio(Math.min(2, devicePixelRatio || 1)); R.setSize(W, H);
  R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.05;
  R.domElement.className = 'gl-fg'; st.appendChild(R.domElement);
  S = new THREE.Scene(); C = new THREE.PerspectiveCamera(40, W / H, 0.1, 100); C.position.set(0, 0, 12);
  VH = 2 * 12 * Math.tan(THREE.MathUtils.degToRad(20)); VW = VH * W / H;
  const pm = new THREE.PMREMGenerator(R); S.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  key = new THREE.PointLight(0xffffff, 60, 30); S.add(key, new THREE.AmbientLight(0xffffff, 0.4));
  const geo = tileGeo(), loader = new THREE.TextureLoader(), jobs = [];
  st.querySelectorAll('.logo, .ic img, .node img').forEach((img, i) => {
    const big = img.classList.contains('logo');
    const side = new THREE.MeshPhysicalMaterial({ color: big ? 0x0f9e6e : 0xf4f3ee, metalness: big ? 0.35 : 0.05, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 });
    const face = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    jobs.push(raster(img.src).then((tx) => { tx.colorSpace = THREE.SRGBColorSpace; tx.offset.set(0.5, 0.5); tx.anisotropy = 8; face.map = tx; face.needsUpdate = true; }).catch((e) => console.warn("[fg] texture failed", img.src, e)));
    const m = new THREE.Mesh(geo, [face, side]);
    const item = img.closest('[data-in]'), sec = img.closest('.scene');
    const si = [...st.querySelectorAll('.scene')].indexOf(sec);
    img.classList.add('x3d'); S.add(m);
    tiles.push({ img, m, big, i, item, sec, si });
  });
  return Promise.all(jobs).then(() => CINE.init({ S, stage, W, H, VW, VH, tiles }));
}

function alphaOf(el) {
  let o = el.style.opacity === '' ? 1 : +el.style.opacity;
  for (let e = el.parentElement; e && e !== stage; e = e.parentElement) {
    const cs = getComputedStyle(e); if (cs.visibility === 'hidden') return 0; o *= +cs.opacity;
  }
  return o;
}

function render(t) {
  if (!R) return;
  const sr = stage.getBoundingClientRect(), k = sr.width / W;
  key.position.set(Math.sin(t * 0.9) * 7, 3.5 + Math.cos(t * 0.6), 7);
  for (const T of tiles) {
    const a = alphaOf(T.img); T.m.visible = a > 0.01;
    if (!T.m.visible) continue;
    const r = T.img.getBoundingClientRect();
    const x = (r.left + r.width / 2 - sr.left) / k, y = (r.top + r.height / 2 - sr.top) / k;
    const sc = scenes[T.si], local = t - sc.start;
    const delay = T.item ? +T.item.dataset.in : 0;
    const p = spring(clamp((local - delay) / (T.big ? 1.6 : 1.1)));
    const spin = (1 - p) * (T.big ? Math.PI * 3 : Math.PI * (1.2 + (T.i % 3) * 0.3));
    const idle = T.big ? 0.22 : 0.14;
    T.m.position.set((x / W - 0.5) * VW, (0.5 - y / H) * VH, (1 - p) * -5 + (T.big ? 0.6 : 0));
    T.m.rotation.set(Math.sin(t * 1.1 + T.i) * idle * 0.6 - (1 - p) * 0.6, spin + Math.sin(t * 0.8 + T.i * 1.7) * idle, Math.sin(t * 0.5 + T.i) * 0.04);
    T.m.scale.setScalar((r.width / k / W) * VW);
    T.m.material.forEach((mt) => { mt.transparent = a < 0.999; mt.opacity = a; });
  }
  CINE.render(t);
  R.render(S, C);
}

export const FG = { init, render };
