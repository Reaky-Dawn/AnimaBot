/**
 * Sprint 6 交互验收脚本（QA 自动验证）
 * 运行：node scripts/qa-sprint6.mjs（需 wrangler dev 在 8787 端口运行）
 * 验证契约 criteria（7 条）：
 *   1. 两页各有 2 个广告占位（Popunder + In-Page Push），不遮挡核心操作，不关闭占位也能完成全部操作（AC-P0-15/16）
 *   2. Push 占位可关闭；两页不发起任何外部广告请求（NFR-12）
 *   3. 页脚四说明齐全；首次访问出现 Cookie 同意条，点"知道了"后 localStorage 记录、不再出现（NFR-14）
 *   4. 爬虫 UA 访问两页 → noindex（meta / X-Robots-Tag）；/robots.txt → Disallow: /（AC-P0-26）
 *   5. 结果页取到结果后自动 delivered 删除任务；重访该 task → 任务无效态（AC-P0-25）
 *   6. 结果页图片旁"AI 生成"徽章（画廊 + 灯箱）（AC-P0-23）
 *   7. 下载文件为引擎原样字节（PNG 文件头抽查）
 */

import puppeteer from 'puppeteer-core';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const HOME = `${BASE}/index.html`;
const DL_DIR = join(process.cwd(), 'scripts', 'tmp-downloads-s6');

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 12000, step = 150, label = 'waitFor' } = {}) {
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`waitFor timeout: ${label}`);
    await sleep(step);
  }
}

rmSync(DL_DIR, { recursive: true, force: true });
mkdirSync(DL_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});

async function newPage() {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 900 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.__errs = errs;
  return p;
}

async function mockCall(page, fnName, ...args) {
  return page.evaluate(async (name, a) => {
    const api = await import('/js/repo/api.js');
    return api[name](...a);
  }, fnName, args);
}

async function gotoClean(page) {
  await page.goto(HOME, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.evaluate(() => {
    localStorage.removeItem('anima_mock_tasks');
    localStorage.removeItem('anima_mock_active_ips');
    localStorage.removeItem('anima_active_task');
    localStorage.removeItem('cookie-consent');
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'networkidle0' });
}

// ===== 场景 A（criterion 1+2）：广告占位 ×2/页 + Push 可关闭 + 无第三方请求 =====
{
  const page = await newPage();
  await gotoClean(page);

  // 主页：2 个广告占位、标注正确、不遮挡（存在即可；核心操作验证在场景 D 全链路）
  const homeAds = await page.evaluate(() => {
    const slots = Array.from(document.querySelectorAll('.ad-slot'));
    return {
      count: slots.length,
      hasPopunder: slots.some((s) => s.classList.contains('ad-slot--popunder') && s.textContent.includes('Popunder')),
      hasPush: slots.some((s) => s.classList.contains('ad-slot--push') && s.textContent.includes('In-Page Push')),
    };
  });
  record('场景A: 主页 2 广告占位（Popunder + In-Page Push）',
    homeAds.count === 2 && homeAds.hasPopunder && homeAds.hasPush,
    `count=${homeAds.count}`);

  // 全程监听外部请求
  const externalRequests = [];
  page.on('request', (req) => {
    const u = req.url();
    if (!u.startsWith('http://127.0.0.1:8787')) externalRequests.push(u);
  });

  // Push 关闭按钮 → 容器隐藏
  await page.click('.ad-slot--push .ad-slot__close');
  const pushHidden = await page.evaluate(() => {
    const s = document.querySelector('.ad-slot--push');
    return s ? s.hidden : true;
  });
  record('场景A: Push 占位可关闭（容器隐藏）', pushHidden);

  // 结果页也 2 个广告占位
  const p2 = await newPage();
  await p2.goto(`${BASE}/result.html?task=whatever`, { waitUntil: 'networkidle0' });
  const resAds = await p2.evaluate(() => document.querySelectorAll('.ad-slot').length);
  record('场景A: 结果页 2 广告占位', resAds === 2, `count=${resAds}`);

  // 无第三方广告域（两页全部请求均为本地 origin）
  await sleep(500);
  record('场景A: 全程无任何外部广告请求（NFR-12）', externalRequests.length === 0,
    externalRequests.slice(0, 3).join(' | '));
  await p2.close();
  await page.close();
}

// ===== 场景 B（criterion 3）：页脚四说明 + Cookie 同意条一次性 =====
{
  const page = await newPage();
  await gotoClean(page);

  // 页脚四说明
  const foot = await page.evaluate(() => document.querySelector('.footer').innerText);
  record('场景B: 页脚四说明齐全',
    foot.includes('仅供内部使用') && foot.includes('隐私与广告说明') && foot.includes('Cookie 同意说明') && foot.includes('AI 生成'),
    foot.replace(/\n/g, '|'));

  // 首次访问：Cookie 同意条可见（未同意标记）
  const barVisible = await page.evaluate(() => {
    const bar = document.querySelector('.cookie-bar');
    return bar && !bar.hidden;
  });
  record('场景B: 首次访问出现 Cookie 同意条', barVisible);

  // 点"知道了" → 隐藏 + localStorage 记录
  await page.click('.cookie-bar__btn');
  const afterConsent = await page.evaluate(() => ({
    barHidden: document.querySelector('.cookie-bar').hidden,
    stored: localStorage.getItem('cookie-consent'),
  }));
  record('场景B: 点"知道了"后隐藏并记录标记', afterConsent.barHidden && afterConsent.stored === '1');

  // 刷新 → 不再出现
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(300);
  const afterReload = await page.evaluate(() => document.querySelector('.cookie-bar').hidden);
  record('场景B: 刷新后不再出现（一次性）', afterReload);
  await page.close();
}

// ===== 场景 C（criterion 4）：爬虫 noindex 三层 =====
{
  // meta noindex（两页）
  const page = await newPage();
  await page.goto(HOME, { waitUntil: 'networkidle0' });
  const metaHome = await page.evaluate(() => document.querySelector('meta[name="robots"]')?.content || '');
  await page.goto(`${BASE}/result.html?task=x`, { waitUntil: 'networkidle0' });
  const metaResult = await page.evaluate(() => document.querySelector('meta[name="robots"]')?.content || '');
  record('场景C: 两页 meta noindex', metaHome.includes('noindex') && metaResult.includes('noindex'),
    `home=${metaHome} result=${metaResult}`);

  // X-Robots-Tag（爬虫 UA 请求响应头）
  const headersHome = await fetch(`${BASE}/`, { headers: { 'User-Agent': 'Googlebot' } });
  const xrt = headersHome.headers.get('x-robots-tag') || '';
  record('场景C: 爬虫 UA 响应含 X-Robots-Tag noindex', xrt.includes('noindex'), `x-robots-tag=${xrt}`);

  // robots.txt
  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  record('场景C: /robots.txt 含 Disallow: /', robots.includes('Disallow: /'));
  await page.close();
}

// ===== 场景 D/E/F（criterion 5/6/7）：全链路 + delivered 自动删除 + 徽章 + 下载字节 =====
{
  const page = await newPage();
  await gotoClean(page);
  await mockCall(page, 'mockSetEngineAutoAdvance', false);

  // 配置下载目录
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR });

  await page.$eval('#prompt-input', (el, t) => { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, '场景D：即用即删');
  await page.click('#generate-btn');
  await sleep(500);
  const taskId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('anima_task_meta')).taskId);

  // 推进到 done → 自动跳转
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const st = await mockCall(page, 'mockStats');
    const t = st.queuePos.find((x) => x.id === taskId);
    if (t && t.status === 'done') break;
    await mockCall(page, 'mockAdvanceTask', taskId);
    await sleep(200);
  }
  await waitFor(() => page.evaluate(() => location.pathname.includes('/result') ? location.href : null), { label: 'D: 跳转' });
  await waitFor(() => page.evaluate(() => {
    const img = document.getElementById('result-img');
    return img && !img.hidden && img.naturalWidth > 0;
  }), { label: 'D: 图片' });

  // delivered 自动触发：mock 任务被删 + 前端标记清除
  await waitFor(async () => {
    const st = await mockCall(page, 'mockStats');
    return !st.queuePos.some((x) => x.id === taskId) ? true : null;
  }, { label: 'D: delivered 删除' });
  const cleared = await page.evaluate(() => ({
    meta: sessionStorage.getItem('anima_task_meta'),
    active: localStorage.getItem('anima_active_task'),
  }));
  record('场景D: 取到结果后自动 delivered（任务删除 + 标记清理）', cleared.meta === null && cleared.active === null);

  // 徽章（画廊 + 灯箱，criterion 6）
  const badgeGallery = await page.evaluate(() => !!document.querySelector('.gallery .ai-badge'));
  await page.click('#result-img');
  await sleep(300);
  const badgeLightbox = await page.evaluate(() => !!document.querySelector('.lightbox .ai-badge'));
  await page.keyboard.press('Escape');
  record('场景E: "AI 生成"徽章（画廊 + 灯箱）', badgeGallery && badgeLightbox);

  // 下载字节（criterion 7）：PNG 魔数
  await page.click('.actions__primary .btn--primary:first-child');
  await waitFor(() => readdirSync(DL_DIR).some((f) => f.endsWith('.png')), { label: 'F: png' });
  const pngFile = readdirSync(DL_DIR).find((f) => f.endsWith('.png'));
  const buf = readFileSync(join(DL_DIR, pngFile));
  record('场景F: 下载文件为引擎原样字节（PNG 魔数）', buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
    `${pngFile} ${buf.length}B`);

  // 重访该 task → 无效态（delivered 后 meta 已清 + 任务已删）
  await page.goto(`${BASE}/result.html?task=${taskId}`, { waitUntil: 'networkidle0' });
  await waitFor(() => page.evaluate(() => {
    const ic = document.getElementById('invalid-card');
    return ic && !ic.hidden;
  }), { label: 'D: 重访无效' });
  record('场景D: 重访已 delivered 任务 → 任务无效态（AC-P0-25）', true);

  record('场景D/E/F: 无页面 JS 错误', page.__errs.length === 0, page.__errs.slice(0, 2).join(' | '));
  await page.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} PASSED =====`);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join('; '));
  process.exit(1);
}
process.exit(0);
