/**
 * Sprint 4 交互验收脚本（QA 自动验证）
 * 运行：node scripts/qa-sprint4.mjs（需 wrangler dev 在 8787 端口运行）
 * 验证契约 criteria（7 条）：
 *   1. mock 下任务全程节点只前进不回退，最终落在"完成"或"失败"（AC-P0-02）
 *   2. mock 模拟 2+ IP 并发排队时，后入队任务节点 1 显示"前方等待 N 人"，N 与实际排队顺序一致（F07、AC-P0-12）
 *   3. 队列为空提交 → 不显示等待人数（AC-P0-13 后半）
 *   4. 页面隐藏 → 轮询暂停；恢复可见 → 立即补一次并恢复（NFR-03）
 *   5. 任务进行中刷新页面 → 进度/排队位置恢复（NFR-21）
 *   6. 轮询网络异常 → 不崩溃、退避重试、有可见提示
 *   7. 进度条桌面横向、移动纵向；aria-live 播报进度变化
 *
 * mock 控制：页面内动态 import('/js/repo/api.js')（模块单例，与页面同实例）调用
 *   mockSetEngineAutoAdvance(false) 关闭自动推进，用 mockAdvanceTask(id) 手动步进实现确定性断言。
 */

import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787/index.html';

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 12000, step = 150, label = 'waitFor' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
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

// ===== 通用页面工具 =====
async function newPage(viewport = { width: 1280, height: 900 }) {
  const p = await browser.newPage();
  await p.setViewport(viewport);
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.__errs = errs;
  return p;
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

async function getStage(page) {
  return page.evaluate(() => {
    const cur = document.querySelector('.progress__item.is-current');
    return cur ? Number(cur.dataset.stage) : null;
  });
}

async function getPanelState(page) {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.progress__item'));
    return items.map((li) => ({
      stage: Number(li.dataset.stage),
      cls: li.className,
      dot: li.querySelector('.progress__dot').textContent,
      hint: (li.querySelector('.progress__hint') || {}).textContent || '',
    }));
  });
}

async function mockCall(page, fnName, ...args) {
  return page.evaluate(async (name, a) => {
    const api = await import('/js/repo/api.js');
    return api[name](...a);
  }, fnName, args);
}

async function advanceTo(page, taskId, targetStage) {
  // 手动推进直到任务 stage 达到 targetStage
  const start = Date.now();
  while (Date.now() - start < 6000) {
    const st = await mockCall(page, 'mockStats');
    const t = st.queuePos.find((x) => x.id === taskId);
    if (t) {
      const s = { queued: 1, prompting: 2, prompt_done: 3, drawing: 4, done: 5, failed: 5 }[t.status];
      if (s && s >= targetStage) return;
    }
    await mockCall(page, 'mockAdvanceTask', taskId);
    await sleep(250);
  }
  throw new Error(`advanceTo timeout: task ${taskId} target ${targetStage}`);
}

async function gotoClean(page) {
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
  // 清空 mock/会话存储（首次启动干净态）
  await page.evaluate(() => {
    localStorage.removeItem('anima_mock_tasks');
    localStorage.removeItem('anima_mock_active_ips');
    localStorage.removeItem('anima_active_task');
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'networkidle0' });
}

// ===== 场景 A（criterion 1）：节点只前进不回退，最终"完成" =====
{
  const page = await newPage();
  await gotoClean(page);
  await mockCall(page, 'mockSetEngineAutoAdvance', false); // 确定性：手动推进

  await submitPrompt(page, '场景A：节点只前进');
  await sleep(600);

  // 任务已建，节点 1 为当前
  await waitFor(() => getStage(page).then((s) => s === 1), { label: 'A: node1' });
  const taskId = await getTaskId(page);
  record('场景A: 提交后进入节点1', !!taskId, `task=${taskId}`);

  // 逐步推进并采样节点序列，断言单调递增（终态无 is-current，stage 5 单独断言）
  const seen = [1];
  for (let target = 2; target <= 4; target++) {
    await advanceTo(page, taskId, target);
    await waitFor(() => getStage(page).then((s) => s === target), { label: `A: stage${target}` });
    const cur = await getStage(page);
    seen.push(cur);
  }
  // 推进到完成（stage 5）
  await advanceTo(page, taskId, 5);
  await waitFor(async () => {
    const st = await getPanelState(page);
    const n5 = st.find((x) => x.stage === 5);
    return n5 && n5.cls.includes('is-done') && n5.dot === '✓' ? true : null;
  }, { label: 'A: done' });
  seen.push(5);
  const monotonic = seen.every((s, i) => i === 0 || s >= seen[i - 1]);
  record('场景A: 节点全程只前进不回退', monotonic, `序列=${seen.join('→')}`);

  // 最终落在"完成"：节点 5 is-done + 绿勾
  const state = await getPanelState(page);
  const n5 = state.find((x) => x.stage === 5);
  const n4 = state.find((x) => x.stage === 4);
  record('场景A: 终态节点5绿勾完成', n5.cls.includes('is-done') && n5.dot === '✓' && n4.cls.includes('is-done'),
    `n5=${n5.cls}|dot=${n5.dot}`);
  record('场景A: 无页面 JS 错误', page.__errs.length === 0, page.__errs.slice(0, 2).join(' | '));
  await page.close();
}

// ===== 场景 B（criterion 2）：多 IP 并发排队 → "前方等待 N 人" =====
{
  // page1：IP A 提交任务1（停在 queued）
  const p1 = await newPage();
  await gotoClean(p1);
  await mockCall(p1, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(p1, '场景B：任务1');
  await sleep(500);
  const t1 = await getTaskId(p1);
  record('场景B: IP-A 任务1 已提交', !!t1, `task=${t1}`);

  // page2：IP B（独立 sessionStorage）提交任务2 → 应排队 queuePos=1
  const p2 = await newPage();
  await p2.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
  await mockCall(p2, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(p2, '场景B：任务2');
  await sleep(500);
  const t2 = await getTaskId(p2);
  record('场景B: IP-B 任务2 已提交', !!t2 && t2 !== t1, `task=${t2}`);

  // 任务2 节点1 显示"前方等待 1 人"（任务1 更早创建）
  await waitFor(async () => {
    const st = await getPanelState(p2);
    const n1 = st.find((x) => x.stage === 1);
    return n1.hint === '前方等待 1 人' ? n1.hint : null;
  }, { label: 'B: 等待1人' });

  // 推进任务1 → 任务2 排队位置归零 → hint 消失
  await advanceTo(p1, t1, 2); // queued → prompting（离开队列）
  await waitFor(async () => {
    const st = await getPanelState(p2);
    const n1 = st.find((x) => x.stage === 1);
    return n1.hint === '' ? true : null;
  }, { label: 'B: 排队清空' });
  record('场景B: 前方任务完成后排队人数更新', true, 'hint: 1人 → 空');

  // 把任务1、任务2 推进到 done，为场景 C 清空队列
  await advanceTo(p1, t1, 5);
  await advanceTo(p2, t2, 5);
  await sleep(300);
  await p1.close();
  await p2.close();
}

// ===== 场景 C（criterion 3）：队列为空提交 → 不显示等待人数 =====
{
  const page = await newPage();
  await gotoClean(page); // 清空任务表（此时队列为空）
  await mockCall(page, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(page, '场景C：空队列提交');
  await sleep(500);
  const st = await getPanelState(page);
  const n1 = st.find((x) => x.stage === 1);
  record('场景C: 空队列不显示等待人数', n1.hint === '' && n1.cls.includes('is-current'),
    `hint="${n1.hint}" cls=${n1.cls}`);
  // 收尾：推进到 done，释放 IP
  const t = await getTaskId(page);
  await advanceTo(page, t, 5);
  await page.close();
}

// ===== 场景 D（criterion 4）：页面隐藏暂停轮询 / 恢复可见立即补一次 =====
{
  const page = await newPage();
  await gotoClean(page);
  await mockCall(page, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(page, '场景D：切Tab暂停');
  await sleep(500);
  const t = await getTaskId(page);
  await waitFor(() => getStage(page).then((s) => s === 1), { label: 'D: node1' });

  // 隐藏页面（模拟切 Tab）：覆盖 document.hidden + 触发 visibilitychange
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(300);

  // 暂停期间服务端推进 2 步（stage 1 → 3）
  await advanceTo(page, t, 3);
  // 等超过轮询间隔 + 退避（3.5s），UI 不应更新（无轮询）
  await sleep(3500);
  const frozenStage = await getStage(page);
  record('场景D: 隐藏期间轮询暂停（UI 不更新）', frozenStage === 1, `frozen=${frozenStage}（服务端已到3）`);

  // 恢复可见 → 立即补一次轮询
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor(() => getStage(page).then((s) => s >= 3), { label: 'D: 恢复补查' });
  record('场景D: 恢复可见立即补一次并恢复轮询', true, `stage ${frozenStage} → ${await getStage(page)}`);

  const t2 = await getTaskId(page);
  await advanceTo(page, t2 || t, 5);
  await page.close();
}

// ===== 场景 E（criterion 5）：刷新恢复进度（NFR-21） =====
{
  const page = await newPage();
  await gotoClean(page);
  await mockCall(page, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(page, '场景E：刷新恢复');
  await sleep(500);
  const t = await getTaskId(page);
  // 推进到节点 3（提示词完成）
  await advanceTo(page, t, 3);
  await waitFor(() => getStage(page).then((s) => s === 3), { label: 'E: stage3' });

  // 刷新（同会话：sessionStorage 保留 ip hash 与 meta）
  await page.reload({ waitUntil: 'networkidle0' });
  await mockCall(page, 'mockSetEngineAutoAdvance', false); // reload 后模块重载，重新关闭自动推进
  await sleep(800);

  // 状态区恢复：可见、节点 3 为当前（来自 meta.maxStageReached）、输入区锁定
  const restored = await page.evaluate(() => {
    const panel = document.querySelector('.status-panel');
    const cur = document.querySelector('.progress__item.is-current');
    return {
      panelVisible: panel && !panel.hidden,
      stage: cur ? Number(cur.dataset.stage) : null,
      promptLocked: document.getElementById('prompt-input').disabled,
    };
  });
  record('场景E: 刷新后进度恢复（节点3 + 锁定 + 状态区可见）',
    restored.panelVisible && restored.stage === 3 && restored.promptLocked,
    `stage=${restored.stage} locked=${restored.promptLocked}`);

  // 恢复后继续轮询推进到完成
  await advanceTo(page, t, 5);
  await waitFor(async () => {
    const st = await getPanelState(page);
    const n5 = st.find((x) => x.stage === 5);
    return n5 && n5.cls.includes('is-done') ? true : null;
  }, { label: 'E: 恢复后done' });
  record('场景E: 刷新后轮询恢复并推进到完成', true);
  await page.close();
}

// ===== 场景 F（criterion 6）：网络异常不崩溃、退避重试、可见提示 =====
{
  const page = await newPage();
  await gotoClean(page);
  await mockCall(page, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(page, '场景F：网络异常');
  await sleep(500);
  const t = await getTaskId(page);

  // 开启网络异常 → 等待一次轮询周期（退避后 3s）
  await mockCall(page, 'mockSetNetworkError', true);
  await waitFor(async () => {
    const txt = await page.evaluate(() => {
      const el = document.querySelector('.toast-anima');
      return el ? el.textContent : '';
    });
    return txt.includes('连接异常') ? txt : null;
  }, { label: 'F: 异常toast', timeout: 10000 });

  record('场景F: 网络异常有可见提示', true, 'toast=连接异常，正在重试…');
  record('场景F: 异常期间不崩溃（无 JS 错误）', page.__errs.length === 0, page.__errs.slice(0, 2).join(' | '));

  // 关闭异常 → 轮询恢复（推进任务后 UI 更新）
  await mockCall(page, 'mockSetNetworkError', false);
  await advanceTo(page, t, 3);
  await waitFor(() => getStage(page).then((s) => s === 3), { label: 'F: 恢复轮询' });
  record('场景F: 网络恢复后轮询继续推进', (await getStage(page)) === 3);

  await advanceTo(page, t, 5);
  await page.close();
}

// ===== 场景 G（criterion 7）：响应式横向/纵向 + aria-live 播报 =====
{
  // 桌面：横向
  const desk = await newPage({ width: 1280, height: 900 });
  await gotoClean(desk);
  await mockCall(desk, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(desk, '场景G：响应式');
  await sleep(500);
  const t = await getTaskId(desk);
  const deskDir = await desk.evaluate(() => getComputedStyle(document.querySelector('.progress')).flexDirection);
  record('场景G: 桌面进度条横向', deskDir === 'row', `flex-direction=${deskDir}`);

  // 触发 stage 变化 → 检查 aria-live 播报节点（role=status，800ms 窗口内）
  await advanceTo(desk, t, 2);
  await waitFor(() => getStage(desk).then((s) => s === 2), { label: 'G: stage2' });
  const announced = await desk.evaluate(() => {
    const el = Array.from(document.querySelectorAll('[role="status"]')).find((n) => n.classList.contains('visually-hidden'));
    return el ? el.textContent : null;
  });
  record('场景G: aria-live 播报进度变化', !!announced && announced.includes('提示词构思中'), `announce="${announced}"`);
  await advanceTo(desk, t, 5);
  await desk.close();

  // 移动：纵向 + 节点行式
  const mob = await newPage({ width: 375, height: 800 });
  await mob.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
  await mockCall(mob, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(mob, '场景G：移动端');
  await sleep(500);
  const mDir = await mob.evaluate(() => getComputedStyle(document.querySelector('.progress')).flexDirection);
  const mItemDir = await mob.evaluate(() => getComputedStyle(document.querySelector('.progress__item')).flexDirection);
  record('场景G: 移动进度条纵向', mDir === 'column' && mItemDir === 'row',
    `progress=${mDir} item=${mItemDir}`);
  const mt = await getTaskId(mob);
  await advanceTo(mob, mt, 5);
  await mob.close();
}

// ===== 场景 H（criterion 1 后半）：失败终态 =====
{
  const page = await newPage();
  await gotoClean(page);
  await mockCall(page, 'mockSetEngineAutoAdvance', false);
  await submitPrompt(page, '场景H：失败终态');
  await sleep(500);
  const t = await getTaskId(page);
  await waitFor(() => getStage(page).then((s) => s === 1), { label: 'H: node1' });

  // 引擎失败回写 → 节点 5 红标 ✕ + 步骤名"失败"
  await mockCall(page, 'mockFailTask', t);
  await waitFor(async () => {
    const st = await getPanelState(page);
    const n5 = st.find((x) => x.stage === 5);
    return n5 && n5.cls.includes('is-failed') ? true : null;
  }, { label: 'H: failed' });
  const st = await getPanelState(page);
  const n5 = st.find((x) => x.stage === 5);
  const n5label = await page.evaluate(() => document.querySelector('.progress__item[data-stage="5"] .progress__label').textContent);
  record('场景H: 失败终态节点5红标', n5.cls.includes('is-failed') && n5.dot === '✕' && n5label === '失败',
    `cls=${n5.cls} dot=${n5.dot} label=${n5label}`);
  // 失败释放 IP：同一 ip 可再次提交
  const freed = await mockCall(page, 'mockStats');
  record('场景H: 失败后 IP 释放（可再提交）', !(await page.evaluate((id) => {
    const ips = JSON.parse(localStorage.getItem('anima_mock_active_ips') || '{}');
    return Object.values(ips).includes(id);
  }, t)), 'active_ips 已不含该任务');
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
