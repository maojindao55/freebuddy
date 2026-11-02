import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'out');
const FRAMES = path.join(OUT, 'frames');
const FPS = +(process.env.FPS || 30);
const W = 1600, H = 900;

async function openPage() {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'] }).catch(() => chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'] }));
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    return { browser, page };
  } catch {}
  try {
    const puppeteer = (await import('puppeteer')).default;
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    return { browser, page };
  } catch {}
  console.error('需要 playwright 或 puppeteer：npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const { browser, page } = await openPage();
const url = pathToFileURL(path.join(DIR, process.env.PAGE || 'index.html')).href + '?export';
await page.goto(url, { waitUntil: 'networkidle' }).catch(() => page.goto(url));
await page.evaluate(() => window.__ready);
const T = await page.evaluate(() => window.PROMO.T);
const total = Math.round(T * FPS);

if (process.env.SAMPLE) {
  const times = process.env.SAMPLE.split(',').map(Number);
  for (const t of times) {
    await page.evaluate((x) => window.render(x), t);
    const f = path.join(OUT, `sample-${t.toFixed(1)}s.png`);
    await page.screenshot({ path: f, clip: { x: 0, y: 0, width: W, height: H } });
    console.log('样张：', f);
  }
  await browser.close();
  rmSync(FRAMES, { recursive: true, force: true });
  process.exit(0);
}

for (let i = 0; i < total; i++) {
  await page.evaluate((t) => window.render(t), i / FPS);
  await page.screenshot({ path: path.join(FRAMES, `${String(i).padStart(4, '0')}.png`), clip: { x: 0, y: 0, width: W, height: H } });
  if (i % FPS === 0) process.stdout.write(`\r帧 ${i}/${total}`);
}
await browser.close();
console.log(`\r帧 ${total}/${total} 完成`);

const input = ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, '%04d.png')];
const SFX = process.env.SFX;
const audio = [];
if (SFX) {
  const wav = path.join(OUT, (process.env.NAME || 'promo') + '.wav');
  execFileSync('python3', [path.join(DIR, SFX), wav], { stdio: 'inherit' });
  audio.push('-i', wav, '-c:a', 'aac', '-b:a', '192k', '-shortest');
}
execFileSync('ffmpeg', [...input, ...audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', path.join(OUT, (process.env.NAME || 'promo') + '.mp4')], { stdio: 'inherit' });

if (!process.env.KEEP_FRAMES) rmSync(FRAMES, { recursive: true, force: true });
console.log('输出：', path.join(OUT, (process.env.NAME || 'promo') + '.mp4'));
