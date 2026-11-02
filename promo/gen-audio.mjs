// 程序化合成 BGM 与音效（无版权素材），与 index.html 场景时间轴对齐
// 输出：out/audio/bgm.wav、out/audio/sfx.wav（48kHz / 16bit / 立体声）
import { writeFileSync, mkdirSync } from 'node:fs';

const SR = 48000, DUR = 16, N = SR * DUR, TAU = Math.PI * 2;
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const buf = () => [new Float32Array(N), new Float32Array(N)];

function add(b, t0, len, fn, pan = 0) {
  const s0 = Math.floor(t0 * SR), n = Math.floor(len * SR);
  const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < n; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const v = fn(i / SR);
    b[0][k] += v * gl; b[1][k] += v * gr;
  }
}

// 场景与和弦：C maj7 → Am7 → Fmaj7 → G7 → Cadd9
const scenes = [
  [0, 2.8, [48, 55, 64, 71]],
  [2.8, 6.4, [45, 52, 60, 67]],
  [6.4, 9.6, [41, 48, 57, 64]],
  [9.6, 12.8, [43, 50, 59, 65]],
  [12.8, 16, [48, 55, 62, 64, 71]],
];
const chordAt = (t) => scenes.find(([s, e]) => t >= s && t < e)[2];

// ---------- BGM ----------
const bgm = buf();
for (const [s, e, notes] of scenes) {
  const len = e - s + 0.8; // 尾音与下一和弦交叠
  notes.forEach((m, j) => {
    const f = hz(m);
    add(bgm, s, len, (t) => {
      const env = Math.min(1, t / 0.6) * (t > len - 0.8 ? (len - t) / 0.8 : 1);
      let v = 0;
      for (const d of [0.9985, 1.0015]) v += Math.sin(TAU * f * d * t) + 0.25 * Math.sin(TAU * 2 * f * d * t);
      return v * env * 0.05;
    }, (j % 2 ? 0.35 : -0.35));
  });
  // 低音根音
  const root = hz(notes[0] - 12);
  add(bgm, s, len, (t) => Math.sin(TAU * root * t) * Math.min(1, t / 0.05) * Math.exp(-t * 0.6) * 0.16);
}
// 琶音：120 BPM 八分音符
for (let step = 0, t = 0.8; t < 14.8; t += 0.25, step++) {
  const ch = chordAt(t), f = hz(ch[step % ch.length] + 12);
  add(bgm, t, 0.6, (x) => (Math.sin(TAU * f * x) + 0.3 * Math.sin(TAU * 3 * f * x)) * Math.exp(-x * 9) * 0.07, step % 2 ? 0.3 : -0.3);
}
// 节奏：第 2 场景起进鼓，最后一场景收掉
for (let t = 2.8; t < 12.8; t += 0.5) {
  add(bgm, t, 0.4, (x) => Math.sin(TAU * (45 * x + (75 / 18) * (1 - Math.exp(-18 * x)))) * Math.exp(-x * 9) * 0.32);
  add(bgm, t + 0.25, 0.08, (x) => rnd() * Math.exp(-x * 70) * 0.05, 0.2);
}

// ---------- SFX ----------
const sfx = buf();
// 转场 whoosh：低通噪声扫频
for (const at of [2.8, 6.4, 9.6, 12.8]) {
  const len = 0.55; let y = 0;
  add(sfx, at - 0.3, len, (t) => {
    const p = t / len, a = 0.02 + 0.35 * p;
    y += a * (rnd() - y);
    return y * Math.sin(Math.PI * p) ** 2 * 0.9;
  });
}
// 开场 Logo 闪音（h1 data-in=0.5）
[72, 76, 79, 84].forEach((m, i) => {
  const f = hz(m);
  add(sfx, 0.45 + i * 0.06, 0.9, (t) => Math.sin(TAU * f * t) * Math.exp(-t * 5) * 0.1, -0.4 + i * 0.27);
});
// 计数 0→14 滴答（场景 2：data-in=0.2，dur=1.3）
for (let i = 0; i < 14; i++) {
  const f = 1800 + i * 40;
  add(sfx, 3.0 + (i / 13) * 1.3, 0.05, (t) => Math.sin(TAU * f * t) * Math.exp(-t * 80) * 0.12);
}
// 收尾钟鸣 + 低频托底
for (const [m, g] of [[76, 0.12], [83, 0.08]]) {
  const f = hz(m);
  add(sfx, 13.1, 2.6, (t) => (Math.sin(TAU * f * t) + 0.4 * Math.sin(TAU * 2.76 * f * t) * Math.exp(-t * 3) + 0.2 * Math.sin(TAU * 5.4 * f * t) * Math.exp(-t * 6)) * Math.exp(-t * 1.6) * g);
}
add(sfx, 13.05, 1.2, (t) => Math.sin(TAU * 55 * t) * Math.exp(-t * 4) * 0.3);

// ---------- 输出 ----------
function writeWav(path, b) {
  let peak = 0;
  for (const ch of b) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  const g = peak ? 0.708 / peak : 1; // 归一到 -3 dBFS
  const out = Buffer.alloc(44 + N * 4);
  out.write('RIFF', 0); out.writeUInt32LE(36 + N * 4, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
  out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++) for (let c = 0; c < 2; c++) {
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, b[c][i] * g)) * 32767), 44 + i * 4 + c * 2);
  }
  writeFileSync(path, out);
  console.log(path, 'peak', peak.toFixed(3));
}
mkdirSync('out/audio', { recursive: true });
writeWav('out/audio/bgm.wav', bgm);
writeWav('out/audio/sfx.wav', sfx);
