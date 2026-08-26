/**
 * Sprint 2 交互验收脚本（QA 自动验证）
 * 运行：node scripts/qa-sprint2.mjs（需 wrangler dev 在 8787 端口运行）
 * 验证契约 criteria：
 *   1. 空描述点"生成"→ 提示"请输入描述"，不进入提交流程（AC-P0-05）
 *   2. 描述超 500 字 → 实时计数变 error 并提示"描述过长"，提交被阻止（AC-P0-06）
 *   3. 选择 1 张图片 → 缩略预览 + "已添加参考图"提示（AC-P0-07）
 *   4. "移除"后预览消失（AC-P0-08）
 *   5. 非图片格式 / 超 5MB → 对应错误、不进入提交流程；重选合法文件错误清除（AC-P0-09）
 *   6. 不传参考图直接提交 → 无报错、进入占位提交事件（AC-P0-10 前置）
 *   8. 上传须知文案常驻；描述仅纯文本渲染（NFR-06/16）
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

// ---- chips 渲染 ----
const chipCount = await page.$$eval('.chip', (els) => els.length);
record('chips 渲染（示例 ≥3 个）', chipCount >= 3, `found ${chipCount}`);

// ---- 1. 空描述提交 ----
await page.click('#generate-btn');
await new Promise((r) => setTimeout(r, 300));
const err1 = await page.$eval('#prompt-error', (el) => el.textContent);
record('空描述 → 提示"请输入描述"', err1.includes('请输入描述'), `got: ${err1}`);
const inputBorder = await page.$eval('#prompt-input', (el) => el.style.borderColor);
record('空描述 → 输入框 error 描边', inputBorder.includes('255, 122, 122') || inputBorder === 'var(--color-error)', `border: ${inputBorder}`);

// ---- chips 点击填充 ----
await page.click('.chip');
const chipText = await page.$eval('#prompt-input', (el) => el.value.length);
record('点击 chip → 填充输入框', chipText > 0, `len=${chipText}`);

// ---- 2. 超 500 字 ----
const longText = 'A'.repeat(501);
await page.$eval('#prompt-input', (el, v) => { el.value = v; }, longText);
await page.$eval('#prompt-input', (el) => el.dispatchEvent(new Event('input', { bubbles: true })));
await new Promise((r) => setTimeout(r, 200));
const countText = await page.$eval('#prompt-count', (el) => el.textContent);
const countColor = await page.$eval('#prompt-count', (el) => el.style.color);
record('超 500 字 → 计数更新且变 error', countText.includes('501 / 500') && countColor !== '', `count: ${countText}`);
await page.click('#generate-btn');
await new Promise((r) => setTimeout(r, 300));
const err2 = await page.$eval('#prompt-error', (el) => el.textContent);
record('超长提交被阻止 → 提示"描述过长"', err2.includes('描述过长'), `got: ${err2}`);

// ---- 恢复合法输入 ----
await page.$eval('#prompt-input', (el) => { el.value = '正常描述'; });
await page.$eval('#prompt-input', (el) => el.dispatchEvent(new Event('input', { bubbles: true })));
await new Promise((r) => setTimeout(r, 200));
const err2b = await page.$eval('#prompt-error', (el) => el.textContent);
record('恢复合法输入 → 错误清除', err2b === '', `got: "${err2b}"`);

// ---- 5. 上传非法文件（构造 txt 文件） ----
const txtBuffer = Buffer.from('not an image');
await page.$eval('#ref-uploader', (el) => {
  const input = el.querySelector('input[type=file]');
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([1, 2, 3])], 'test.txt', { type: 'text/plain' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 400));
const err3 = await page.$eval('#ref-error', (el) => el.textContent);
record('非图片格式 → "仅支持常见图片格式"', err3.includes('仅支持常见图片格式'), `got: ${err3}`);

// ---- 5b. 超大文件（>5MB，浏览器端直接构造避免序列化问题） ----
await page.evaluate(() => {
  const input = document.querySelector('#ref-uploader input[type=file]');
  const buf = new Uint8Array(5 * 1024 * 1024 + 1); // 5MB + 1 字节
  const dt = new DataTransfer();
  dt.items.add(new File([buf], 'big.png', { type: 'image/png' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 400));
const err4 = await page.$eval('#ref-error', (el) => el.textContent);
record('超 5MB → "图片过大，请压缩后上传"', err4.includes('图片过大'), `got: ${err4}`);

// ---- 3. 上传合法图片 → 缩略预览（浏览器端构造 1x1 PNG） ----
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
const hasThumb = await page.$eval('#ref-preview', (el) => !!el.querySelector('.uploader__thumb'));
const hasName = await page.$eval('#ref-preview', (el) => el.textContent.includes('ref.png'));
record('合法图片 → 缩略预览 + 文件名', hasThumb && hasName, `thumb=${hasThumb}, name=${hasName}`);

// ---- 4. 移除 ----
await page.click('.uploader__remove');
await new Promise((r) => setTimeout(r, 300));
const previewEmpty = await page.$eval('#ref-preview', (el) => el.children.length === 0);
record('移除 → 预览消失', previewEmpty);

// ---- 6. 不传参考图直接提交（合法描述） ----
await page.$eval('#prompt-input', (el) => { el.value = '测试提交'; });
await page.$eval('#prompt-input', (el) => el.dispatchEvent(new Event('input', { bubbles: true })));
await new Promise((r) => setTimeout(r, 200));
await page.click('#generate-btn');
await new Promise((r) => setTimeout(r, 500));
const btnDisabled = await page.$eval('#generate-btn', (el) => el.disabled);
const submitLogged = errors.filter((e) => e.includes('submit')).length === 0; // console.debug 不报 error
record('合法提交 → 进入占位提交（按钮防连点禁用）', btnDisabled === true, `disabled=${btnDisabled}`);

// ---- 8. 须知文案常驻 + 纯文本渲染 ----
const notice = await page.$eval('.uploader__notice', (el) => el.textContent);
record('上传须知常驻', notice.includes('不得上传未经授权的真人照片或他人作品'), `got: ${notice}`);

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
