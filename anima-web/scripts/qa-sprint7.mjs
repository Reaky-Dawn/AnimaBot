/**
 * Sprint 7 交互验收脚本（QA 自动验证）
 * 运行：node scripts/qa-sprint7.mjs（需 wrangler dev 在 8787 端口运行）
 * 验证契约 criteria（6 条）：
 *   1. mock 引擎对含 NSFW 标签的描述回写 rejected(nsfw_rejected) → Toast"内容不符合站点要求"，
 *      不生成图片、不进入结果展示、不跳转（AC-P0-20 前端呈现层）
 *   2. rejected 后输入区与上传区恢复可编辑，可修改描述重新提交（AC-P0-20 交互）
 *   3. 政治敏感 rejected → 文案"内容不符合要求"（NFR-10 前端口径）
 *   4. 主页不存在任何可修改拦截状态的开关/入口；站务说明浮层明示"服务端配置、默认开启"（AC-P0-22/D5）
 *   5. 代码审查：拦截判定逻辑不在前端（前端仅渲染服务端回写的 rejected 状态，无前端绕过路径）
 *   6. 拦截开启状态对新提交任务生效（服务端配置变更后新任务按新状态处理；政治敏感不受开关影响）
 */

import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const HOME = `${BASE}/index.html`;

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10000, step = 150, label = 'waitFor' } = {}) {
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`waitFor timeout: ${label}`);
    await sleep(step);
  }
}

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
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'networkidle0' });
}

async function submitPrompt(page, text) {
  await page.$eval('#prompt-input', (el, t) => {
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await page.click('#generate-btn');
}

async function getToast(page) {
  return page.evaluate(() => {
    const t = document.querySelector('.toast-anima');
    return t ? t.textContent : '';
  });
}

// ===== 场景 A（criterion 1）：NSFW rejected → 拦截 Toast、不跳转、不进节点条 =====
{
  const page = await newPage();
  await gotoClean(page);
  await submitPrompt(page, '画一个裸体少女在沙滩上奔跑');
  // 第一次轮询即回写 rejected → toast
  await waitFor(() => getToast(page).then((t) => t.includes('内容不符合站点要求') ? t : null), { label: 'A: NSFW toast' });
  const toastA = await getToast(page);
  record('场景A: NSFW rejected → Toast"内容不符合站点要求"', toastA.includes('内容不符合站点要求'), `toast=${toastA}`);

  // 不跳转（停留主页）；状态区被隐藏（rejected 不进入节点条）
  await sleep(2000);
  const stayHome = await page.evaluate(() => location.pathname === '/' || location.pathname.includes('index.html'));
  const statusHidden = await page.evaluate(() => {
    const sp = document.querySelector('.status-panel');
    return sp ? sp.hidden : true;
  });
  record('场景A: 不跳转结果页 + 不进入节点条', stayHome && statusHidden, `stayHome=${stayHome} statusHidden=${statusHidden}`);

  // 场景 B（criterion 2）：rejected 后输入区/上传区恢复可编辑 → 修改描述重新提交
  const unlocked = await page.evaluate(() => ({
    prompt: !document.getElementById('prompt-input').disabled,
    uploader: document.getElementById('ref-uploader').getAttribute('aria-disabled') !== 'true',
    chip: !document.querySelector('.chip').disabled,
    gen: !document.getElementById('generate-btn').disabled,
  }));
  record('场景B: rejected 后输入区/上传区/chips/生成全部恢复可编辑',
    unlocked.prompt && unlocked.uploader && unlocked.chip && unlocked.gen,
    JSON.stringify(unlocked));

  await page.$eval('#prompt-input', (el) => { el.value = '正常描述：黄昏天台少女回眸'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#generate-btn');
  await sleep(800);
  const reSubmitted = await page.evaluate(() => {
    const sp = document.querySelector('.status-panel');
    return sp && !sp.hidden;
  });
  record('场景B: 修改描述重新提交进入节点流程（IP 已释放）', reSubmitted);
  // 收尾：推进到 done 释放任务
  const taskId = await page.evaluate(() => { const m = JSON.parse(sessionStorage.getItem('anima_task_meta') || 'null'); return m ? m.taskId : null; });
  if (taskId) {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const st = await mockCall(page, 'mockStats');
      const t = st.queuePos.find((x) => x.id === taskId);
      if (t && t.status === 'done') break;
      await mockCall(page, 'mockAdvanceTask', taskId);
      await sleep(150);
    }
  }
  await page.close();
}

// ===== 场景 C（criterion 3）：政治敏感 rejected → "内容不符合要求" =====
{
  const page = await newPage();
  await gotoClean(page);
  await submitPrompt(page, '深夜组织游行示威的人群');
  await waitFor(() => getToast(page).then((t) => t.includes('内容不符合要求') ? t : null), { label: 'C: 敏感 toast' });
  const toastC = await getToast(page);
  record('场景C: 政治敏感 rejected → Toast"内容不符合要求"', toastC.includes('内容不符合要求') && !toastC.includes('站点要求'), `toast=${toastC}`);
  await page.close();
}

// ===== 场景 D（criterion 4）：主页无拦截开关 + 站务说明浮层 =====
{
  const page = await newPage();
  await gotoClean(page);

  // 无任何可修改拦截状态的开关/入口（无 checkbox/toggle/含"开关"或"拦截"文案的控件）
  const noSwitch = await page.evaluate(() => {
    const switches = Array.from(document.querySelectorAll('input[type=checkbox], input[type=radio], [role=switch]'));
    const text = document.body.innerText;
    return switches.length === 0 && !/拦截开关|启用拦截|关闭拦截|NSFW 开关/.test(text);
  });
  record('场景D: 主页无任何拦截开关/入口', noSwitch);

  // 站务说明浮层：打开 → 文案 → 关闭（按钮 / Esc）
  await page.click('.topbar__admin');
  await waitFor(() => page.evaluate(() => {
    const d = document.getElementById('admin-note');
    return d && !d.hidden;
  }), { label: 'D: 浮层开' });
  const noteText = await page.evaluate(() => document.querySelector('.admin-note__text').textContent);
  record('场景D: 浮层明示"服务端配置、默认开启、页面不设开关"',
    noteText.includes('服务端配置') && noteText.includes('默认开启') && noteText.includes('页面不设开关'),
    noteText);

  await page.click('.admin-note__close');
  const closedByBtn = await page.evaluate(() => document.getElementById('admin-note').hidden);
  await page.click('.topbar__admin');
  await waitFor(() => page.evaluate(() => !document.getElementById('admin-note').hidden), { label: 'D: 浮层再开' });
  await page.keyboard.press('Escape');
  const closedByEsc = await page.evaluate(() => document.getElementById('admin-note').hidden);
  record('场景D: 浮层关闭按钮 / Esc 均可关闭', closedByBtn && closedByEsc);
  await page.close();
}

// ===== 场景 E（criterion 5）：代码审查——拦截判定不在前端业务层 =====
{
  const apiSrc = readFileSync(join(process.cwd(), 'public', 'js', 'repo', 'api.js'), 'utf8');
  const uiSrc = readFileSync(join(process.cwd(), 'public', 'js', 'ui', 'components.js'), 'utf8');
  const serviceSrc = readFileSync(join(process.cwd(), 'public', 'js', 'service', 'task-service.js'), 'utf8');
  const homeSrc = readFileSync(join(process.cwd(), 'public', 'js', 'runtime', 'home.js'), 'utf8');

  // 检测词表与判定函数仅存在于 api.js（mock 模拟"引擎回写"层），ui/service/runtime 无检测逻辑
  const detectionSymbols = ['NSFW_WORDS', 'SENSITIVE_WORDS', 'mockSimulateEngineCheck'];
  const leaked = detectionSymbols.filter((s) =>
    uiSrc.includes(s) || serviceSrc.includes(s) || homeSrc.includes(s)
  );
  record('场景E: 检测词表/判定函数仅存在于 repo.mock 层（ui/service/runtime 无拦截判定）', leaked.length === 0,
    leaked.join(', ') || '无泄漏');

  // real（Worker 联调）分支无检测：realCreateTask 内不含 NSFW 检测调用
  const realSection = apiSrc.split('// ===== 真实 API 实现')[1] || '';
  record('场景E: 真实 API 分支（real mode）无拦截判定（判定在 Worker/引擎侧）',
    !realSection.includes('mockSimulateEngineCheck') && !realSection.includes('NSFW_WORDS'));

  // 前端仅渲染 rejected 状态：业务层只引用 FAILURE_REASON 文案映射，无修改任务状态路径
  record('场景E: 前端仅渲染 rejected（home.js 无任何本地改状态路径）',
    !homeSrc.includes('TASK_STATUS.REJECTED =') && !homeSrc.includes('status = "rejected"'));
}

// ===== 场景 F（criterion 6）：服务端配置变更对新任务生效（政治敏感不受开关影响） =====
// 每步独立新页面，避免跨步状态干扰（tryRestore 恢复旧任务触发跳转等）
{
  // 步骤 1：NSFW 过滤关闭（mockSetNsfwFilterEnabled=false）→ 含 NSFW 词新任务不被拦截
  const p1 = await newPage();
  await gotoClean(p1);
  await mockCall(p1, 'mockSetNsfwFilterEnabled', false);
  await submitPrompt(p1, '画一个裸体少女在森林');
  await sleep(1500);
  const noToast = await getToast(p1);
  const enteredQueue = await p1.evaluate(() => {
    const sp = document.querySelector('.status-panel');
    return sp && !sp.hidden;
  });
  record('场景F: NSFW 过滤关闭后，含 NSFW 词新任务不再被拒（进入队列）',
    noToast === '' && enteredQueue, `toast="${noToast}" enteredQueue=${enteredQueue}`);
  await p1.close();

  // 步骤 2：恢复过滤（默认 true）→ 新任务恢复拦截（独立新页，模块默认 true）
  const p2 = await newPage();
  await gotoClean(p2);
  // 不调 mockSetNsfwFilterEnabled——模块默认 true
  await submitPrompt(p2, '画一个裸体少女在森林');
  await waitFor(() => getToast(p2).then((t) => t.includes('内容不符合站点要求') ? t : null), { label: 'F: 恢复拦截' });
  record('场景F: 重新开启后新任务恢复拦截', true);
  await p2.close();

  // 步骤 3：政治敏感不受开关影响（开关关闭时仍恒定拦截）
  const p3 = await newPage();
  await gotoClean(p3);
  await mockCall(p3, 'mockSetNsfwFilterEnabled', false);
  await submitPrompt(p3, '组织游行的人群');
  await waitFor(() => getToast(p3).then((t) => t.includes('内容不符合要求') ? t : null), { label: 'F: 敏感仍拦截' });
  record('场景F: 政治敏感拦截不受 NSFW 开关影响（恒定拦截，NFR-10）', true);
  await p3.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} PASSED =====`);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join('; '));
  process.exit(1);
}
process.exit(0);
