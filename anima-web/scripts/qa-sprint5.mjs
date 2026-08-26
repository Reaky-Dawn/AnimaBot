/**
 * Sprint 5 交互验收脚本（QA 自动验证）
 * 运行：node scripts/qa-sprint5.mjs（需 wrangler dev 在 8787 端口运行）
 * 验证契约 criteria（8 条）：
 *   1. 节点"完成"→ 主页终态展示约 1.5s 后自动跳转 result.html?task=<id>，无需点击，主页无"查看结果"按钮（AC-P0-03/14）
 *   2. 结果页展示 1 张生成图片（AC-P0-03）
 *   3. 下载 PNG/JPEG 均触发浏览器下载，文件可正常打开（AC-P0-04）
 *   4. 点击图片 → 灯箱全屏展示；关闭按钮/Esc/点遮罩均可退出并回到结果页（AC-P0-17）
 *   5. 失败任务 → 自动跳转结果页失败态：失败原因 + 重试；重试 → 携带原描述（及参考图）重新提交进入节点流程（AC-P0-18）
 *   6. "再生成一张"→ 返回主页全新输入态，已提交内容不残留（AC-P0-19）
 *   7. 直接访问无效/已删除 task → 任务无效态卡 + 返回主页按钮，不出现死胡同（AC-P0-25）
 *   8. 画廊先占位后呈现（NFR-02）；"请勿外传链接"提示条常驻（NFR-18）
 */

import puppeteer from 'puppeteer-core';
import { mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const HOME = `${BASE}/index.html`;
const DL_DIR = join(process.cwd(), 'scripts', 'tmp-downloads');

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
    try { v = await fn(); } catch (e) { v = null; } // 导航竞态（context destroyed）视为未就绪
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`waitFor timeout: ${label}`);
    await sleep(step);
  }
}

// 干净下载目录
rmSync(DL_DIR, { recursive: true, force: true });
mkdirSync(DL_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});

async function newPage(viewport = { width: 1280, height: 900 }) {
  const p = await browser.newPage();
  await p.setViewport(viewport);
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

async function getTaskId(page) {
  return page.evaluate(() => {
    const m = JSON.parse(sessionStorage.getItem('anima_task_meta') || 'null');
    return m ? m.taskId : null;
  });
}

/** 手动推进到终态 done（auto-advance 关闭 + mockAdvanceTask） */
async function advanceToDone(page, taskId) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const st = await mockCall(page, 'mockStats');
    const t = st.queuePos.find((x) => x.id === taskId);
    if (t && t.status === 'done') return;
    await mockCall(page, 'mockAdvanceTask', taskId);
    await sleep(200);
  }
  throw new Error('advanceToDone timeout');
}

/** 等待主页跳转 result（wrangler dev 对 result.html 做 307 清理 URL → /result） */
async function waitJump(page, timeout = 6000) {
  return waitFor(() => page.evaluate(() => location.pathname.includes('/result') ? location.href : null),
    { timeout, label: 'jump' });
}

// ===== 场景 A + 部分 G（criterion 1/2/8）：完成自动跳转 + 结果展示 + 提示条 =====
{
  const page = await newPage();
  await gotoClean(page);
  await mockCall(page, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(page, '场景A：完整成功链路');
  await sleep(500);
  const taskId = await getTaskId(page);

  // 主页无"查看结果"按钮（用户决策三：自动跳转，无按钮）
  const hasViewBtn = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a')).some((b) => b.textContent.trim().includes('查看结果'))
  );
  record('场景A: 主页无"查看结果"按钮', hasViewBtn === false);

  // 推进到 done → 终态提示出现 → 自动跳转
  await advanceToDone(page, taskId);
  await waitFor(() => page.evaluate(() => {
    const el = document.getElementById('status-terminal');
    return el && !el.hidden && el.textContent.includes('正在前往结果页') ? el.textContent : null;
  }), { label: 'A: 终态提示' });
  const terminalText = await page.evaluate(() => document.getElementById('status-terminal').textContent);
  record('场景A: 终态展示"生成完成，正在前往结果页…"', terminalText.includes('生成完成'), `text=${terminalText}`);

  const jumpedUrl = await waitJump(page);
  record('场景A: 约 1.5s 后自动跳转 result.html?task=<id>', jumpedUrl.includes(`task=${taskId}`), jumpedUrl);

  // 结果页：画廊展示生成图 + AI 徽章 + 提示条
  await waitFor(() => page.evaluate(() => {
    const img = document.getElementById('result-img');
    return img && !img.hidden && img.naturalWidth > 0;
  }), { label: 'A: 图片就绪' });
  const imgState = await page.evaluate(() => {
    const img = document.getElementById('result-img');
    return { w: img.naturalWidth, ph: document.getElementById('gallery-placeholder').hidden };
  });
  record('场景A: 结果页展示生成图片（占位隐藏）', imgState.w > 0 && imgState.ph, `naturalWidth=${imgState.w}`);

  const badge = await page.evaluate(() => !!document.querySelector('.gallery .ai-badge'));
  const notice = await page.evaluate(() => document.body.innerText.includes('请勿外传链接'));
  record('场景A: "AI 生成"徽章 + "请勿外传链接"提示条常驻', badge && notice, `badge=${badge} notice=${notice}`);

  // 下载目录配置（场景 B 用）
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR });

  // ---- 场景 B（criterion 3）：下载 PNG / JPEG ----
  const dlBefore = existsSync(DL_DIR) ? readdirSync(DL_DIR).length : 0;
  await page.click('.actions__primary .btn--primary:first-child'); // 下载 PNG
  await waitFor(() => readdirSync(DL_DIR).some((f) => f.endsWith('.png')), { label: 'B: png 下载' });
  const pngFile = readdirSync(DL_DIR).find((f) => f.endsWith('.png'));
  const pngBuf = readFileSync(join(DL_DIR, pngFile));
  const pngOk = pngBuf[0] === 0x89 && pngBuf[1] === 0x50 && pngBuf[2] === 0x4e && pngBuf[3] === 0x47;
  record('场景B: 下载 PNG 文件头为 PNG 魔数', pngOk && pngBuf.length > 5000, `${pngFile} ${pngBuf.length}B`);

  await page.click('.actions__primary .btn--primary:last-child'); // 下载 JPEG
  await waitFor(() => readdirSync(DL_DIR).some((f) => f.endsWith('.jpg') || f.endsWith('.jpeg')), { label: 'B: jpg 下载' });
  const jpgFile = readdirSync(DL_DIR).find((f) => f.endsWith('.jpg') || f.endsWith('.jpeg'));
  const jpgBuf = readFileSync(join(DL_DIR, jpgFile));
  const jpgOk = jpgBuf[0] === 0xff && jpgBuf[1] === 0xd8;
  record('场景B: 下载 JPEG 文件头为 JPEG 魔数', jpgOk && jpgBuf.length > 3000, `${jpgFile} ${jpgBuf.length}B`);

  // ---- 场景 C（criterion 4）：灯箱 ----
  await page.click('#result-img'); // 打开灯箱
  await waitFor(() => page.evaluate(() => !document.getElementById('lightbox').hidden), { label: 'C: 灯箱开' });
  const lbOpen = await page.evaluate(() => {
    const lb = document.getElementById('lightbox');
    return !lb.hidden && document.getElementById('lightbox-img').src.length > 0;
  });
  const bodyLocked = await page.evaluate(() => document.body.style.overflow === 'hidden');
  record('场景C: 灯箱全屏打开 + 背景滚动锁定', lbOpen && bodyLocked);

  await page.click('.lightbox__close'); // 关闭按钮
  await waitFor(() => page.evaluate(() => document.getElementById('lightbox').hidden), { label: 'C: 灯箱关' });
  const scrolledBack = await page.evaluate(() => document.body.style.overflow !== 'hidden');
  record('场景C: 关闭按钮退出并解锁滚动', scrolledBack);

  await page.click('#result-img');
  await waitFor(() => page.evaluate(() => !document.getElementById('lightbox').hidden), { label: 'C: 灯箱再开' });
  await page.keyboard.press('Escape'); // Esc 关闭
  await waitFor(() => page.evaluate(() => document.getElementById('lightbox').hidden), { label: 'C: Esc 关' });
  record('场景C: Esc 退出灯箱', true);

  await page.click('#result-img');
  await waitFor(() => page.evaluate(() => !document.getElementById('lightbox').hidden), { label: 'C: 灯箱三开' });
  await page.mouse.click(30, 30); // 点遮罩（左上角远离图片）
  await waitFor(() => page.evaluate(() => document.getElementById('lightbox').hidden), { label: 'C: 遮罩关' });
  record('场景C: 点遮罩退出灯箱', true);
  record('场景A/C: 无页面 JS 错误', page.__errs.length === 0, page.__errs.slice(0, 2).join(' | '));
  await page.close();
}

// ===== 场景 D（criterion 5）：失败自动跳转 + 重试回填 =====
{
  const page = await newPage();
  await gotoClean(page);
  await mockCall(page, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(page, '场景D：失败重试');
  await sleep(500);
  const taskId = await getTaskId(page);

  // 引擎失败回写 → 主页终态"生成失败" → 自动跳转
  await mockCall(page, 'mockFailTask', taskId, 'draw_failed');
  await waitFor(() => page.evaluate(() => {
    const el = document.getElementById('status-terminal');
    return el && !el.hidden && el.textContent.includes('生成失败') ? true : null;
  }), { label: 'D: 失败终态' });
  await waitJump(page);
  record('场景D: 失败任务自动跳转结果页失败态', true);

  // 失败卡：原因 + 重试按钮
  await waitFor(() => page.evaluate(() => {
    const fc = document.getElementById('fail-card');
    return fc && !fc.hidden;
  }), { label: 'D: 失败卡' });
  const failState = await page.evaluate(() => ({
    reason: document.querySelector('.fail-card__text').textContent,
    retryEnabled: !document.getElementById('retry-btn').disabled,
    regenEnabled: !document.querySelector('.actions__return .btn').disabled,
  }));
  record('场景D: 失败原因 + 重试/再生成可用', failState.reason === '绘制失败，请重试' && failState.retryEnabled && failState.regenEnabled,
    `reason=${failState.reason}`);

  // 点重试 → 回主页预填原描述 → 提交进入节点流程
  await page.click('#retry-btn');
  await waitFor(() => page.evaluate(() => location.pathname.includes('index.html') || location.pathname === '/'), { label: 'D: 回主页' });
  await waitFor(() => page.evaluate(() => document.getElementById('prompt-input').value.length > 0), { label: 'D: 预填' });
  const prefilled = await page.evaluate(() => document.getElementById('prompt-input').value);
  record('场景D: 重试回主页预填原描述', prefilled === '场景D：失败重试', `value=${prefilled}`);

  await page.click('#generate-btn');
  await sleep(600);
  const statusVisible = await page.evaluate(() => {
    const sp = document.querySelector('.status-panel');
    return sp && !sp.hidden;
  });
  record('场景D: 重试后重新提交进入节点流程', statusVisible);
  const t2 = await getTaskId(page);
  await advanceToDone(page, t2);
  await page.close();
}

// ===== 场景 E（criterion 6）：再生成一张 → 全新输入态 =====
{
  const page = await newPage();
  await gotoClean(page);
  await mockCall(page, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(page, '场景E：再生成');
  await sleep(400);
  const taskId = await getTaskId(page);
  await advanceToDone(page, taskId);
  await waitJump(page);
  await waitFor(() => page.evaluate(() => {
    const img = document.getElementById('result-img');
    return img && !img.hidden && img.naturalWidth > 0;
  }), { label: 'E: 图片' });

  await page.click('.actions__return .btn'); // 再生成一张
  await waitFor(() => page.evaluate(() => location.pathname.includes('index.html') || location.pathname === '/'), { label: 'E: 回主页' });
  await sleep(400);
  const fresh = await page.evaluate(() => ({
    prompt: document.getElementById('prompt-input').value,
    statusHidden: document.querySelector('.status-panel').hidden,
    noMeta: sessionStorage.getItem('anima_task_meta') === null,
  }));
  record('场景E: 再生成返回全新输入态（无残留）', fresh.prompt === '' && fresh.statusHidden && fresh.noMeta,
    `prompt="${fresh.prompt}" statusHidden=${fresh.statusHidden} noMeta=${fresh.noMeta}`);
  await page.close();
}

// ===== 场景 F（criterion 7）：任务无效态 =====
{
  const page = await newPage();
  await gotoClean(page);
  // 1) 直接访问随机无效 task（无会话 meta）
  await page.goto(`${BASE}/result.html?task=00000000-0000-0000-0000-000000000000`, { waitUntil: 'networkidle0' });
  await waitFor(() => page.evaluate(() => {
    const ic = document.getElementById('invalid-card');
    return ic && !ic.hidden;
  }), { label: 'F: 无效卡' });
  const invState = await page.evaluate(() => ({
    galleryHidden: document.querySelector('.gallery__frame').hidden || !document.querySelector('.gallery__frame'),
    backBtn: !!document.querySelector('.invalid-card a.btn'),
  }));
  record('场景F: 无效 task → 无效卡 + 返回主页按钮', invState.backBtn);

  // 2) 已删除任务（即用即删语义）：创建→done→删除→重访 → 无效态
  await page.goto(HOME, { waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    localStorage.removeItem('anima_mock_tasks');
    localStorage.removeItem('anima_mock_active_ips');
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await mockCall(page, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(page, '场景F：删除后重访');
  await sleep(400);
  const taskId = await getTaskId(page);
  await advanceToDone(page, taskId);
  // 模拟交付确认删除（Sprint 6 正式接入 delivered；此处直接调 mock 删除）
  await page.evaluate(async (id) => {
    const m = JSON.parse(sessionStorage.getItem('anima_task_meta'));
    const api = await import('/js/repo/api.js');
    await api.deleteTask(id, m.taskToken);
  }, taskId);
  await page.goto(`${BASE}/result.html?task=${taskId}`, { waitUntil: 'networkidle0' });
  await waitFor(() => page.evaluate(() => {
    const ic = document.getElementById('invalid-card');
    return ic && !ic.hidden;
  }), { label: 'F: 删除后无效卡' });
  record('场景F: 已删除任务重访 → 无效态（不出现死胡同）', true);

  // 返回主页按钮可用
  await page.click('.invalid-card a.btn');
  await waitFor(() => page.evaluate(() => location.pathname.includes('index.html') || location.pathname === '/'), { label: 'F: 回主页' });
  record('场景F: 返回主页按钮可用', true);
  await page.close();
}

// ===== 场景 G（criterion 8）：画廊先占位后呈现（NFR-02，跳转前拦截图片延迟 800ms） =====
{
  const page = await newPage();
  await gotoClean(page);
  await mockCall(page, 'mockSetEngineAutoAdvance', false);
  // 禁缓存 + 拦截结果图请求（延迟 800ms 放行）——在跳转前就绪，首次加载结果页即生效
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('sample-result.png')) {
      setTimeout(() => req.continue(), 800);
    } else {
      req.continue();
    }
  });

  await submitPrompt(page, '场景G：占位呈现');
  await sleep(400);
  const taskId = await getTaskId(page);
  await advanceToDone(page, taskId);
  await waitJump(page); // 自动跳转（不经 waitUntil，图片请求仍被延迟中）

  // 图片加载完成前的窗口：占位可见、图片未显示
  await sleep(250);
  const duringLoad = await page.evaluate(() => ({
    placeholderVisible: !document.getElementById('gallery-placeholder').hidden,
    imgHidden: document.getElementById('result-img').hidden,
  }));
  record('场景G: 图片未就绪时先显示占位（渐进呈现 NFR-02）', duringLoad.placeholderVisible && duringLoad.imgHidden,
    `placeholderVisible=${duringLoad.placeholderVisible} imgHidden=${duringLoad.imgHidden}`);

  // 放行后图片呈现、占位隐藏
  await waitFor(() => page.evaluate(() => {
    const img = document.getElementById('result-img');
    return img && !img.hidden && img.naturalWidth > 0;
  }), { label: 'G: 图片呈现', timeout: 6000 });
  const afterLoad = await page.evaluate(() => document.getElementById('gallery-placeholder').hidden);
  record('场景G: 图片就绪后占位隐藏', afterLoad);
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
