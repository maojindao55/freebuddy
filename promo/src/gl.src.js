import * as THREE from 'three';
import { FG } from './fg.src.js';

// Deterministic WebGL backdrop: every frame is a pure function of t.
const SHAPES = ['sphere', 'ring', 'stream', 'nodes'];
const N = 7000;
const ss = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; }

function buildAttrs() {
  const r = rng(42), A = {};
  for (const k of ['aSphere', 'aRing', 'aStream', 'aNodes']) A[k] = new Float32Array(N * 3);
  const seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u), j = i * 3;
    const R = 1.7 + (r() - 0.5) * 0.25;
    A.aSphere.set([s * Math.cos(th) * R, u * R, s * Math.sin(th) * R], j);
    const rr = 3.4 + (r() - 0.5) * 0.9, ph = r() * Math.PI * 2;
    A.aRing.set([Math.cos(ph) * rr, (r() - 0.5) * 0.35, Math.sin(ph) * rr], j);
    const lane = Math.floor(r() * 14);
    A.aStream.set([r() * 14 - 7, (lane - 6.5) * 0.42 + (r() - 0.5) * 0.15, (r() - 0.5) * 2.5], j);
    const c = Math.floor(r() * 4);
    if (c < 3) {
      const cr = 0.85 * Math.cbrt(r());
      A.aNodes.set([(c - 1) * 3.6 + s * Math.cos(th) * cr, u * cr, s * Math.sin(th) * cr], j);
    } else {
      A.aNodes.set([r() * 7.2 - 3.6, (r() - 0.5) * 0.06, (r() - 0.5) * 0.06], j);
    }
    seed[i] = r();
  }
  return { A, seed };
}

const PVERT = `
attribute vec3 aSphere, aRing, aStream, aNodes; attribute float aSeed;
uniform vec4 uW; uniform float uT, uBurst, uPx;
varying float vA, vG; varying vec2 vS;
vec3 rotY(vec3 p, float a){ float c=cos(a), s=sin(a); return vec3(c*p.x+s*p.z, p.y, -s*p.x+c*p.z); }
void main(){
  vec3 sp = rotY(aSphere, uT*0.25) * (1.0 + 0.06*sin(uT*1.6 + aSeed*6.28));
  vec3 rg = rotY(aRing, uT*0.35 + aSeed*0.2); rg.y += sin(uT*2.0 + aSeed*12.0)*0.08; rg = vec3(rg.x, rg.y*0.9 - rg.z*0.44, rg.y*0.44 + rg.z*0.9);
  vec3 st = aStream; st.x = mod(st.x + uT*(0.6 + aSeed*1.0) + 7.0, 14.0) - 7.0;
  vec3 nd = aNodes; if (abs(nd.y) < 0.05 && abs(nd.z) < 0.05) nd.x = mod(nd.x + uT*2.4 + 3.6, 7.2) - 3.6;
  else nd = nd + vec3(sin(uT+aSeed*9.0), cos(uT*1.3+aSeed*7.0), 0.0)*0.05;
  vec3 p = sp*uW.x + rg*uW.y + st*uW.z + nd*uW.w;
  p *= 1.0 + uBurst * (2.5 + aSeed*4.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vS = gl_Position.xy / gl_Position.w;
  gl_PointSize = uPx * (2.2 + aSeed*3.0) * (8.0 / -mv.z) * (1.0 + 0.5*(uW.y + uW.w));
  vA = (0.6 + 0.4*aSeed) * (1.0 - 0.7*uBurst);
  vG = step(0.55, aSeed);
}`;
const PFRAG = `
uniform vec4 uW;
varying float vA, vG; varying vec2 vS;
void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
  vec3 col = mix(vec3(0.60,0.59,0.64), vec3(0.063,0.725,0.506), vG);
  float edge = smoothstep(1.05, 0.7, abs(vS.x));
  float mid = mix(0.3, 1.0, smoothstep(0.15, 0.6, length(vS * vec2(0.8, 1.6))));
  float f = mix(1.0, edge * mid, uW.z);
  gl_FragColor = vec4(col, vA * f * smoothstep(0.5, 0.15, d)); }`;

const BVERT = `
uniform float uT, uAmp; varying vec3 vN, vV;
void main(){ vec3 p = position;
  float n = sin(p.x*2.1+uT*1.3)*sin(p.y*2.4+uT*1.1)*sin(p.z*1.9+uT*0.9);
  p += normal * n * 0.28 * uAmp;
  vec4 mv = modelViewMatrix * vec4(p, 1.0); vN = normalize(normalMatrix*normal); vV = -mv.xyz;
  gl_Position = projectionMatrix * mv; }`;
const BFRAG = `
uniform float uO; varying vec3 vN, vV;
void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
  vec3 base = mix(vec3(0.97,0.96,0.94), vec3(0.85,0.93,0.89), vN.y*0.5+0.5);
  vec3 col = mix(base, vec3(0.063,0.725,0.506), f);
  gl_FragColor = vec4(col, uO * (0.25 + 0.75*f)); }`;

let renderer, scene, camera, pts, blob, scenes = [];

function init(stage, list) {
  scenes = list;
  const W = stage.clientWidth, H = stage.clientHeight;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(W, H);
  const cv = renderer.domElement;
  cv.className = 'gl-bg';
  const grid = stage.querySelector('.grid-bg');
  grid ? grid.after(cv) : stage.prepend(cv);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100);
  camera.position.set(0, 0, 12);

  const { A, seed } = buildAttrs();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(A.aSphere, 3));
  for (const k in A) g.setAttribute(k, new THREE.BufferAttribute(A[k], 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  pts = new THREE.Points(g, new THREE.ShaderMaterial({
    vertexShader: PVERT, fragmentShader: PFRAG, transparent: true, depthWrite: false,
    uniforms: { uW: { value: new THREE.Vector4(1, 0, 0, 0) }, uT: { value: 0 }, uBurst: { value: 0 }, uPx: { value: renderer.getPixelRatio() } },
  }));
  pts.frustumCulled = false;
  scene.add(pts);

  blob = new THREE.Mesh(new THREE.IcosahedronGeometry(1.45, 48), new THREE.ShaderMaterial({
    vertexShader: BVERT, fragmentShader: BFRAG, transparent: true, depthWrite: false,
    uniforms: { uT: { value: 0 }, uAmp: { value: 1 }, uO: { value: 1 } },
  }));
  scene.add(blob);
}

function weights(t) {
  const i = Math.max(0, scenes.findIndex((s) => t >= s.start && t < s.end));
  const cur = scenes[i], prev = scenes[i - 1] || cur;
  const k = ss(0, 1.2, t - cur.start);
  const w = [0, 0, 0, 0];
  w[SHAPES.indexOf(prev.shape)] += 1 - k;
  w[SHAPES.indexOf(cur.shape)] += k;
  return { w, last: i === scenes.length - 1, cur };
}

function render(t) {
  if (!renderer) return;
  const { w, last, cur } = weights(t);
  const burst = last ? ss(cur.end - 2.9, cur.end - 2.2, t) * (1 - ss(cur.end - 2.2, cur.end - 1.0, t)) : 0;
  const u = pts.material.uniforms;
  u.uW.value.set(...w); u.uT.value = t; u.uBurst.value = burst;
  const b = blob.material.uniforms;
  b.uT.value = t; b.uO.value = w[0] * (1 - 0.7 * burst);
  b.uAmp.value = 0.6 + 0.4 * Math.sin(t * 0.8);
  blob.visible = b.uO.value > 0.01;
  blob.scale.setScalar(1 + burst * 0.6);
  blob.rotation.set(t * 0.15, t * 0.2, 0);
  camera.position.set(Math.sin(t * 0.3) * 0.8, Math.cos(t * 0.25) * 0.4, 12 - w[2] * 2.5);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}

window.GL = { init: (st, l) => { init(st, l); window.GL.ready = FG.init(st, l); }, render: (t) => { render(t); FG.render(t); } };
