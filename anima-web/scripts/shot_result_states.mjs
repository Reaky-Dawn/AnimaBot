/**
 * shot_result_states.mjs — 结果页 5 状态 × 2 视口截图（自证图标错位用）
 * 用法: node shot_result_states.mjs
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8931';
const PAGE_URL = BASE + '/result.html';
const SAMPLE = BASE + '/assets/sample-result.png';
const OUT = 'D:\\build\\webdev\\AnimaBot\\_shots';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const states = {
  loading: () => {},
  success: (sampleUrl) => {
    document.getElementById('gallery-placeholder').hidden = true;
    const img = document.getElementById('result-img');
    img.src = sampleUrl; img.hidden = false;
    document.querySelectorAll('.actions .btn').forEach(b => (b.disabled = false));
  },
  failed: () => {
    document.getElementById('gallery-placeholder').hidden = true;
    document.getElementById('fail-card').hidden = false;
  },
  invalid: () => {
    document.getElementById('invalid-card').hidden = false;
  },
  lightbox: (sampleUrl) => {
    document.getElementById('gallery-placeholder').hidden = true;
    const img = document.getElementById('result-img');
    img.src = sampleUrl; img.hidden = false;
    const lb = document.getElementById('lightbox');
    document.getElementById('lightbox-img').src = sampleUrl;
    lb.hidden = false;
  },
};

const viewports = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 },
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
try {
  for (const vp of viewports) {
    for (const [name, apply] of Object.entries(states)) {
      const page = await browser.newPage();
      // 屏蔽外链（注入的广告脚本会重定向页面），只放行本地资源
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const u = req.url();
        // 屏蔽外链 + 屏蔽页面逻辑脚本（纯布局检查，状态由 evaluate 控制）
        if (u.includes('js/runtime/result.js') || !u.startsWith(BASE)) req.abort();
        else req.continue();
      });
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 2 });
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.evaluate(apply, SAMPLE);
      await new Promise(r => setTimeout(r, 300));
      await page.screenshot({ path: `${OUT}\\result_${name}_${vp.name}.png` });
      await page.close();
      console.log(`shot: result_${name}_${vp.name}.png`);
    }
  }
} finally {
  await browser.close();
}
console.log('DONE');
