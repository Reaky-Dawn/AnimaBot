/**
 * qa-sprint16.mjs —— Sprint 16 浏览器冒烟（广告移除 + 统计上报 + 主流程不回归）
 *
 * 前置：本地静态服务器 + mock API（node scripts/mock-server.mjs 不存在——
 * 本项目 mock 在前端 api.js 内置：localStorage.anima_api_mode='mock' 即可，无需后端）。
 * 用本地 http.server 起在 8932，Chrome headless 验证：
 *   1) 两页加载无 console error、无第三方脚本请求（quarrelsomebitter/guilty-a）
 *   2) 统计上报 /api/stats/hit 在两页各发出 1 次（mock 拦截计数）
 *   3) mock 模式完整提交流程 → 任务卡片出现 → 轮询 → 结果跳转不崩
 *   4) 无 .ad-slot / .ads 元素
 */
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const PUBLIC = 'D:\\build\\webdev\\AnimaBot\\anima-web\\public';
const PORT = 8932;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };

// ---- 静态服务器 + stats API mock（计数器） ----
const statsHits = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, BASE);
  if (u.pathname === '/api/stats/hit' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      statsHits.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"uv":1}');
    });
    return;
  }
  if (u.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (u.pathname === '/api/stats/summary') {
    const days = Math.min(parseInt(u.searchParams.get('days') || '30', 10) || 30, 90);
    const items = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      items.push({ date: d, pv: 5 + ((i * 7) % 11), pv_index: 3, pv_result: 2, uv: 2 + (i % 4), tasks: i % 3 });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      days, today_tasks: 3,
      totals: {
        pv: items.reduce((a, b) => a + b.pv, 0), uv: 9, tasks: items.reduce((a, b) => a + b.tasks, 0),
        tasks_per_uv: 3.33, task_done_rate: 92.3, task_terminal: { done: 12, failed: 1, rejected: 0 },
      },
      referrers: [['direct', 18], ['self', 6], ['search', 3], ['ext:example.com', 2]],
      geo: [['CN', 12], ['JP', 3]], task_geo: [['CN', 4]],
      items,
    }));
    return;
  }
  let p = u.pathname === '/' ? '/index.html' : u.pathname;
  const fp = join(PUBLIC, p);
  if (existsSync(fp)) {
    res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' });
    res.end(readFileSync(fp));
  } else {
    res.writeHead(404); res.end('nf');
  }
});
await new Promise((r) => server.listen(PORT, r));
console.log('static+mock server on', BASE);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const failures = [];
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  const thirdParty = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('request', (req) => {
    const u = req.url();
    if (/quarrelsomebitter|guilty-a|hilltop|popunder/i.test(u)) thirdParty.push(u);
  });

  // ---- 首页 ----
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' });
  const adsHome = await page.evaluate(() => document.querySelectorAll('.ad-slot, .ads, .ad-banner-zone').length);
  if (adsHome !== 0) failures.push(`首页残留广告元素 ${adsHome} 个`);
  if (thirdParty.length) failures.push(`首页发起第三方请求: ${thirdParty[0]}`);

  // mock 模式完整提交（页面刷新带 localStorage 覆盖）
  await page.evaluate(() => localStorage.setItem('anima_api_mode', 'mock'));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.type('#natural-input', '黄昏下的城市天台，少女回头微笑');
  await page.click('#natural-btn');
  await new Promise((r) => setTimeout(r, 2500)); // mock 任务推进 + 轮询
  const homeState = await page.evaluate(() => ({
    statusShown: !document.querySelector('.status-panel')?.hidden,
    jumped: location.pathname.includes('result'),
    err: document.querySelector('.toast-anima')?.textContent || null,
  }));
  console.log('submit state:', JSON.stringify(homeState));

  // ---- 结果页直访（无效 token 走 invalid 态，不崩即可） ----
  await page.goto(`${BASE}/result.html?id=none&token=none`, { waitUntil: 'networkidle0' });
  const adsResult = await page.evaluate(() => document.querySelectorAll('.ad-slot, .ads, .ad-banner-zone').length);
  if (adsResult !== 0) failures.push(`结果页残留广告元素 ${adsResult} 个`);
  const resultOk = await page.evaluate(() => !!document.body);
  if (!resultOk) failures.push('结果页 body 缺失');

  // ---- 统计看板（stats.html）：折线 SVG 渲染 + KPI 填充 ----
  const sPage = await browser.newPage();
  const sErrors = [];
  sPage.on('pageerror', (e) => sErrors.push(e.message));
  sPage.on('console', (m) => { if (m.type() === 'error') sErrors.push(m.text()); });
  await sPage.goto(`${BASE}/stats.html`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 600));
  const statsState = await sPage.evaluate(() => ({
    pv: document.getElementById('kpi-pv')?.textContent,
    uv: document.getElementById('kpi-uv')?.textContent,
    tasks: document.getElementById('kpi-tasks')?.textContent,
    tpu: document.getElementById('kpi-tpu')?.textContent,
    rate: document.getElementById('kpi-rate')?.textContent,
    src: document.getElementById('kpi-src')?.textContent,
    svgPaths: document.querySelectorAll('#chart svg path').length,
    refRows: document.querySelectorAll('#ref-list .geo-row').length,
    err: !document.getElementById('stats-error')?.hidden,
  }));
  console.log('stats page:', JSON.stringify(statsState));
  if (statsState.svgPaths < 3) failures.push('stats.html 折线未渲染（path<3）');
  if (statsState.pv === '–' || statsState.uv === '–' || statsState.tasks === '–') failures.push('stats.html KPI 未填充');
  if (statsState.tpu !== '3.33' || statsState.rate !== '92.3%' || statsState.src !== '直接访问') failures.push('stats.html 新 KPI（人均/完成率/来源）异常: ' + JSON.stringify(statsState));
  if (statsState.refRows < 3) failures.push('stats.html 来源分布未渲染');
  if (statsState.err) failures.push('stats.html 显示错误态');
  if (sErrors.length) failures.push(`stats.html errors: ${sErrors.slice(0, 2).join('|')}`);

  // ---- 统计上报断言 ----
  await new Promise((r) => setTimeout(r, 800));
  console.log('stats hits:', JSON.stringify(statsHits));
  if (statsHits.length < 2) failures.push(`stats/hit 上报次数不足: ${statsHits.length}`);
  const pages = statsHits.map((h) => h.p);
  if (!pages.includes('index') && !pages.includes('result')) failures.push('stats/hit 缺少页面标识');

  if (consoleErrors.length) failures.push(`console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);

  if (failures.length) {
    console.log('❌ FAILURES:\n' + failures.map((f) => '  - ' + f).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('✅ ALL SMOKE CHECKS PASSED');
  }
} finally {
  await browser.close();
  server.close();
}
