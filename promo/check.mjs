import { chromium } from 'playwright';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const W = 1600, H = 900;
const times = (process.env.T || '1.8,5.6,9.0,12.2,15.2').split(',').map(Number);
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('requestfailed', (r) => errs.push('请求失败 ' + r.url()));
await page.goto(pathToFileURL(path.join(DIR, 'index.html')).href + '?export');
await page.evaluate(() => window.__ready);
for (const t of times) {
  const r = await page.evaluate(({ t, W, H }) => {
    window.render(t);
    const out = { t, scene: null, issues: [], info: {} };
    const sc = [...document.querySelectorAll('.scene')].find((s) => s.style.visibility === 'visible');
    if (!sc) { out.issues.push('无可见场景'); return out; }
    out.scene = (sc.id || sc.className) + ` [${sc.dataset.start}-${sc.dataset.end}] opacity=${(+sc.style.opacity).toFixed(2)}`;
    sc.querySelectorAll('img').forEach((im) => { if (!im.naturalWidth) out.issues.push('图片未加载 ' + im.getAttribute('src')); });
    sc.querySelectorAll('[data-count]').forEach((el) => {
      out.info.count = `${el.textContent} / 目标 ${el.dataset.count}`;
      if (el.textContent !== el.dataset.count) out.issues.push('计数未到位 ' + out.info.count);
    });
    const ics = [...sc.querySelectorAll('.ic')];
    if (ics.length) {
      const rows = {};
      ics.forEach((el) => { const b = el.getBoundingClientRect(); const k = Math.round(b.top / 10) * 10; rows[k] = (rows[k] || 0) + 1; });
      out.info.iconRows = Object.values(rows);
      const moving = ics.filter((el) => el.style.transform && !/translate\(0px, 0px\)|translate\(-?0px, -?0px\)/.test(el.style.transform)).length;
      out.info.iconsMoving = moving;
      if (JSON.stringify(out.info.iconRows) !== '[7,7]') out.issues.push('图标行分布 ' + JSON.stringify(out.info.iconRows));
    }
    sc.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || +cs.opacity === 0) return;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return;
      const tag = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '');
      if (b.left < -2 || b.top < -2 || b.right > W + 2 || b.bottom > H + 2) out.issues.push(`越界 ${tag} [${b.left|0},${b.top|0},${b.right|0},${b.bottom|0}]`);
      if (el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'visible' && el.clientWidth) out.issues.push(`文字溢出 ${tag} ${el.scrollWidth}>${el.clientWidth}`);
    });
    out.info.lines = [...sc.querySelectorAll('h1,h2,h3,p,.lead,.tag')].map((el) => {
      const rg = document.createRange(); rg.selectNodeContents(el);
      const tops = new Set([...rg.getClientRects()].map((x) => Math.round(x.top)));
      return `${el.tagName.toLowerCase()}:${tops.size}行「${el.textContent.trim().slice(0, 18)}」`;
    });
    return out;
  }, { t, W, H });
  console.log(`\n==== ${r.t}s  ${r.scene}`);
  console.log('信息', JSON.stringify(r.info, null, 0));
  console.log(r.issues.length ? '问题:\n  - ' + [...new Set(r.issues)].slice(0, 15).join('\n  - ') : '✅ 无问题');
}
console.log('\n==== 页面错误', errs.length ? errs : '无');
await browser.close();
