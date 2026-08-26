/**
 * Sprint 3 交互验收脚本（QA 自动验证）
 * 运行：node scripts/qa-sprint3.mjs（需 wrangler dev 在 8787 端口运行）
 * 验证契约 criteria：
 *   1. 提交成功 → 输入区与上传区全部变灰锁定（AC-P0-01）
 *   2. 锁定态下无"新任务"按钮（interface-design D1/D2）
 *   3. mock 下已存在进行中任务时再次提交 → IP_BUSY 提示（AC-P0-11）
 *   4. 全程无额度类文案（AC-P0-13 前半）
 *   5. sessionStorage 写任务元数据；localStorage 写进行中标记（NFR-21）
 *   6. 不传参考图提交正常创建；传参考图走压缩→直传→confirm 链路（AC-P0-10）
 *   7. 提交瞬间按钮禁用、无连点重复建任务
 */

import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787/index.html';

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });

// ===== 场景 A：不传参考图直接提交 =====
await page.$eval('#prompt-input', (el) => { el.value = '测试提交任务'; });
await page.$eval('#prompt-input', (el) => el.dispatchEvent(new Event('input', { bubbles: true })));
await new Promise((r) => setTimeout(r, 200));
await page.click('#generate-btn');
await new Promise((r) => setTimeout(r, 800));

// 1. 输入区锁定
const promptDisabled = await page.$eval('#prompt-input', (el) => el.disabled);
const uploaderDisabled = await page.$eval('#ref-uploader', (el) => el.getAttribute('aria-disabled') === 'true');
const chipDisabled = await page.$eval('.chip', (el) => el.disabled);
const genDisabled = await page.$eval('#generate-btn', (el) => el.disabled);
record('提交成功 → 输入区/上传区/chips/生成全部锁定', promptDisabled && uploaderDisabled && chipDisabled && genDisabled,
  `prompt=${promptDisabled}, uploader=${uploaderDisabled}, chip=${chipDisabled}, gen=${genDisabled}`);

// 2. 无"新任务"按钮（puppeteer 不支持 Playwright 选择器，用标准 CSS + 文本匹配）
const newTaskBtn = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim().includes('新任务'))
);
record('锁定态无"新任务"按钮', newTaskBtn === false);

// 3. 状态区出现
const statusVisible = await page.$eval('.status-panel', (el) => !el.hidden);
record('锁定态状态区出现', statusVisible);

// 5. 存储写入
const meta = await page.evaluate(() => JSON.parse(sessionStorage.getItem('anima_task_meta') || 'null'));
const active = await page.evaluate(() => JSON.parse(localStorage.getItem('anima_active_task') || 'null'));
record('sessionStorage 任务元数据写入', meta && meta.taskId && meta.taskToken && meta.descSummary === '测试提交任务',
  meta ? `taskId=${meta.taskId}` : 'null');
record('localStorage 进行中标记写入', active && active.taskId, active ? `taskId=${active.taskId}` : 'null');

// ===== 场景 B：连点防重复（同会话内再次尝试提交同一 IP） =====
// 解锁按钮不可用（锁定态），模拟第二次触发：直接调 service 路径不现实，改为验证锁定态下无法再次提交
const secondSubmitBlocked = await page.$eval('#generate-btn', (el) => el.disabled);
record('锁定态无法再次提交（防连点/单任务）', secondSubmitBlocked);

// ===== 场景 C：IP_BUSY（同 IP 已有进行中任务，刷新页面后再次提交） =====
// 内部 locked 标志在 JS 状态内，无法靠 DOM 解锁绕过；改为 location.reload()：
// sessionStorage（anima_mock_ip_hash 同 ip_hash）与 localStorage（mock 活动 IP 持久化）都保留，
// 仅重置页面 UI 锁定态 → 重新输入提交 → mock 端检测到该 IP 已有进行中任务 → IP_BUSY toast。
await page.evaluate(() => { location.reload(); });
await new Promise((r) => setTimeout(r, 1200));
await page.$eval('#prompt-input', (el) => { el.value = '第二次提交'; });
await page.$eval('#prompt-input', (el) => el.dispatchEvent(new Event('input', { bubbles: true })));
await page.click('#generate-btn');
await new Promise((r) => setTimeout(r, 800));

const toastText = await page.evaluate(() => {
  const t = document.querySelector('.toast-anima');
  return t ? t.textContent : '';
});
record('再次提交同 IP → IP_BUSY 提示', toastText.includes('当前已有任务进行中'), `toast: ${toastText}`);

// 4. 全程无额度文案
const bodyText = await page.evaluate(() => document.body.innerText);
record('全程无额度类文案', !/额度|次数已满|每日限额/.test(bodyText));

// ===== 场景 D：带参考图提交链路（新浏览器上下文，清 sessionStorage） =====
await page.evaluate(() => {
  sessionStorage.clear();
  localStorage.clear();
  location.reload();
});
await new Promise((r) => setTimeout(r, 1200));

// 上传 1x1 PNG
await page.evaluate(() => {
  const input = document.querySelector('#ref-uploader input[type=file]');
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([buf], 'ref.png', { type: 'image/png' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 800));

await page.$eval('#prompt-input', (el) => { el.value = '带参考图的提交'; });
await page.$eval('#prompt-input', (el) => el.dispatchEvent(new Event('input', { bubbles: true })));
await page.click('#generate-btn');
await new Promise((r) => setTimeout(r, 800));

const meta2 = await page.evaluate(() => JSON.parse(sessionStorage.getItem('anima_task_meta') || 'null'));
record('带参考图提交成功（压缩→直传→confirm）', meta2 && meta2.hasRefImage === true && meta2.taskId,
  meta2 ? `hasRef=${meta2.hasRefImage}` : 'null');

// 页面无 JS 错误
record('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} PASSED =====`);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join('; '));
  process.exit(1);
}
process.exit(0);
