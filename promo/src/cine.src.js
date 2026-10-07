import * as THREE from 'three';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import fontJson from './fonts/helvetiker_bold.typeface.json';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const eo = (p) => 1 - Math.pow(1 - p, 3);
const eio = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const bell = (t, a, m, b) => (t < a || t > b ? 0 : t < m ? eo((t - a) / (m - a)) : 1 - eio((t - m) / (b - m)));
let X, word, letters = [], total = 0, h1, sec0, secN, flare, vortex = [], logoN;

const FLV = 'varying vec2 vU; void main(){ vU=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
const FLF = `uniform float uI; uniform float uL; varying vec2 vU; void main(){ vec2 q=vU-0.5;
  float ef=smoothstep(0.5,0.28,abs(q.x)); float core=exp(-abs(q.y)*70.0)*exp(-abs(q.x)*2.6)*ef; float halo=exp(-length(q*vec2(1.0,5.0))*7.0);
  vec3 c=mix(vec3(0.02,0.47,0.34), vec3(0.06,0.73,0.5), halo); c=mix(c, vec3(0.78,0.93,0.86), uL);
  gl_FragColor=vec4(c, clamp((core+halo*0.45*ef)*uI,0.0,1.0)); }`;

function box(r) {
  const sr = X.stage.getBoundingClientRect(), k = sr.width / X.W;
  const x = (r.left + r.width / 2 - sr.left) / k, y = (r.top + r.height / 2 - sr.top) / k;
  return { x: (x / X.W - 0.5) * X.VW, y: (0.5 - y / X.H) * X.VH, w: (r.width / k / X.W) * X.VW };
}
const toWorld = (el) => (el ? box(el.getBoundingClientRect()) : null);

export function init(ctx) {
  X = ctx; const secs = [...X.stage.querySelectorAll('.scene')]; sec0 = secs[0]; secN = secs[secs.length - 1];
  h1 = sec0.querySelector('h1'); if (h1) h1.classList.add('x3d-text');
  const font = new FontLoader().parse(fontJson);
  const mat = (c) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.2, metalness: 0.28, clearcoat: 1, clearcoatRoughness: 0.07, transparent: true });
  const ink = mat(0x16151a), grn = mat(0x10b981);
  word = new THREE.Group(); X.S.add(word);
  [...'FreeBuddy'].forEach((ch, i) => {
    const g = new TextGeometry(ch, { font, size: 1, depth: 0.3, curveSegments: 10, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.028, bevelSegments: 5 });
    g.computeBoundingBox(); const bb = g.boundingBox, w = bb.max.x - bb.min.x;
    g.translate(-bb.min.x - w / 2, -0.36, -0.15);
    const m = new THREE.Mesh(g, i >= 4 ? grn : ink); word.add(m);
    letters.push({ m, cx: total + w / 2, i }); total += w + 0.07;
  });
  letters.forEach((L) => (L.cx -= total / 2));
  flare = new THREE.Mesh(new THREE.PlaneGeometry(X.VW * 1.3, 1.6), new THREE.ShaderMaterial({ vertexShader: FLV, fragmentShader: FLF, transparent: true, depthWrite: false, depthTest: false, uniforms: { uI: { value: 0 }, uL: { value: 0 } } }));
  flare.renderOrder = 10; X.S.add(flare);
  X.tiles.filter((T) => T.img.closest('.ic')).forEach((T, i) => {
    const m = new THREE.Mesh(T.m.geometry, T.m.material.map((mt) => mt.clone())); m.visible = false; X.S.add(m); vortex.push({ m, i });
  });
  logoN = secN.querySelector('.logo');
}

export function render(t) {
  if (!X) return;
  const on0 = !!h1 && sec0.style.visibility !== 'hidden';
  word.visible = on0;
  if (on0) {
    const rg = document.createRange(); rg.selectNodeContents(h1);
    const B = box(rg.getBoundingClientRect());
    word.position.set(B.x, B.y, 0.4); word.scale.setScalar(B.w / total);
    word.rotation.set(Math.sin(t * 0.7) * 0.06, Math.sin(t * 0.5) * 0.14, 0);
    const a = +(sec0.style.opacity || 1);
    letters.forEach((L) => {
      const p = eo(clamp((t - 0.45 - L.i * 0.06) / 0.9));
      L.m.position.set(L.cx, (1 - p) * -0.8 + Math.sin(t * 2 + L.i * 0.7) * 0.02, (1 - p) * -3);
      L.m.rotation.set((1 - p) * -1.7, (1 - p) * 0.4, 0);
      L.m.visible = p > 0.01; L.m.material.opacity = a;
    });
  }
  const fi = Math.max(bell(t, 0.05, 0.35, 1.1), bell(t, 13.4, 13.62, 14.5) * 1.2);
  const intro = t < 6; flare.material.uniforms.uI.value = intro ? fi * 0.6 : fi; flare.material.uniforms.uL.value = intro ? 1 : 0; flare.visible = fi > 0.01;
  flare.material.depthTest = intro; flare.renderOrder = intro ? -1 : 10;
  const FL = flare.visible ? toWorld(t < 6 ? sec0.querySelector('.logo') : logoN) : null;
  if (!FL) flare.visible = false;
  if (flare.visible) {
    const L = FL;
    flare.position.set(L.x, L.y, intro ? word.position.z - 0.6 : 2); flare.scale.set(intro ? 0.3 + 0.35 * eo(clamp(t / 0.6)) : 0.4 + 0.8 * eo(clamp((t - 13.4) / 0.35)), 1, 1);
  }
  const local = t - 12.8, L = secN.style.visibility !== 'hidden' ? toWorld(logoN) : null;
  vortex.forEach((V) => {
    const p = clamp((local - V.i * 0.02) / 1.0);
    V.m.visible = !!L && local >= 0 && p < 1;
    if (!V.m.visible) return;
    const e = eio(p), rr = 7.5 * (1 - e), ang = (V.i / vortex.length) * Math.PI * 2 + e * Math.PI * 2.6;
    V.m.position.set(L.x + Math.cos(ang) * rr * 1.3, L.y + Math.sin(ang) * rr * 0.55, Math.sin(ang) * rr * 0.25 - (1 - e) * 1.5);
    V.m.rotation.set(Math.sin(ang) * 0.5, ang + Math.PI * (1 - e), 0);
    V.m.scale.setScalar(1.3 * (1 - 0.85 * e));
    V.m.material.forEach((mt) => { mt.opacity = clamp(local / 0.15); mt.transparent = true; });
  });
}
