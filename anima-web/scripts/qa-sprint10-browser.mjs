/**
 * Sprint 10 QA：前端失败态完整日志展示（浏览器实测，puppeteer-core + 本机 Chrome）
 *
 * 步骤：
 *  1. 打开本地 result.html（Worker dev 同源 8787 提供静态资源）
 *  2. 注入 sessionStorage 任务元数据（taskId/taskToken 与 Worker 中真实任务一致）
 *  3. 访问 result.html?task=<id> → 失败态：显示原因 + "查看完整日志" 折叠
 *  4. 点击折叠 → 展示日志时间线（含步骤名/耗时/错误）
 *  5. 断言：失败卡可见、日志区可见、包含"所有 LLM 槽位均失败"、不含 api_key
 *
 * 前置：wrangler dev --local 已在 8787 运行。
 */
import puppeteer from 'puppeteer-core';

const BASE = 'http://127.0.0.1:8787';
const ENGINE_KEY = 'anima-local-engine-key-test';

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}

async function createFailedTask() {
  // 建任务 → claim → PATCH failed + engine_log
  const createRes = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '一个动漫少女在图书馆的午后', has_ref: false }),
  });
  const created = await createRes.json();
  await fetch(`${BASE}/api/engine/tasks?status=queued&engine_id=engine-qa`, {
    headers: { Authorization: `Bearer ${ENGINE_KEY}` },
  });
  const engineLog = [
    { ts: Date.now() - 9000, elapsed: 0.1, action: 'claim', detail: '任务已接管（提示词构思）' },
    { ts: Date.now() - 6000, elapsed: 3.0, action: 'params_parsed', detail: '尺寸 920x1536' },
    { ts: Date.now() - 3000, elapsed: 6.2, action: 'prompt_generated', detail: '提示词生成完成（tags 118 字符 / natural 76 字符）' },
    { ts: Date.now(), elapsed: 8.4, action: 'failed', detail: 'draw_failed: 所有 LLM 槽位均失败: 槽位1 [https://a.invalid]: connection refused | 槽位2 [https://b.invalid]: timeout | 槽位3 [https://c.invalid]: 401 | 槽位4 [https://d.invalid]: connection refused' },
  ];
  await fetch(`${BASE}/api/engine/tasks/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ENGINE_KEY}` },
    body: JSON.stringify({ status: 'failed', failure_reason: 'draw_failed', engine_log: JSON.stringify(engineLog) }),
  });
  return { id: created.id, token: created.task_token };
}

async function run() {
  const task = await createFailedTask();
  check('前置：失败任务已创建', !!task.id && !!task.token);

  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // 注入会话元数据（result.js 依赖 sessionStorage 校验 taskId/taskToken 匹配）
    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle2' });
    await page.evaluate(({ id, token }) => {
      sessionStorage.setItem('anima_task_meta', JSON.stringify({
        taskId: id, taskToken: token, descSummary: '一个动漫少女在图书馆的午后',
        prompt: '一个动漫少女在图书馆的午后', maxStageReached: 5, queuePos: 0, hasRefImage: false,
      }));
    }, task);

    await page.goto(`${BASE}/result.html?task=${task.id}`, { waitUntil: 'networkidle2' });

    // 失败卡可见
    await page.waitForSelector('#fail-card:not([hidden])', { timeout: 8000 });
    check('失败卡可见', true);
    const failText = await page.$eval('.fail-card__text', (el) => el.textContent);
    check('失败原因文案', failText.includes('绘制失败'));

    // 日志折叠区存在且初始隐藏
    const logVisible = await page.$eval('#fail-card__log', (el) => !el.hidden);
    const bodyHidden = await page.$eval('#fail-card__log-body', (el) => el.hidden);
    check('日志折叠区显示、正文初始收起', logVisible && bodyHidden);

    // 点击展开
    await page.click('#fail-card__log-toggle');
    await new Promise((r) => setTimeout(r, 200));
    const bodyText = await page.$eval('#fail-card__log-body', (el) => el.textContent);
    const bodyHiddenAfter = await page.$eval('#fail-card__log-body', (el) => el.hidden);
    check('点击后正文展开', !bodyHiddenAfter);
    check('日志含错误摘要（所有 LLM 槽位均失败）', bodyText.includes('所有 LLM 槽位均失败'));
    check('日志含先前步骤（参数解析/提示词生成）', bodyText.includes('参数解析') && bodyText.includes('提示词生成'));
    check('日志含阶段结果（尺寸/字符数）', bodyText.includes('920x1536') && bodyText.includes('118 字符'));
    check('日志含具体错误（槽位1 connection refused）', bodyText.includes('槽位1') && bodyText.includes('connection refused'));
    check('日志不含 api_key', !bodyText.includes('anima-local-engine-key-test') && !bodyText.includes('KEY_'));

    // 无页面 JS 错误
    check('无页面 JS 错误', errors.length === 0, errors.join('; '));

    // 再生成按钮可用
    const regenDisabled = await page.$eval('.actions__return .btn', (el) => el.disabled);
    check('再生成可用', !regenDisabled);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== Sprint 10 前端日志展示: ${results.length - failed.length}/${results.length} PASS =====`);
  process.exitCode = failed.length ? 1 : 0;
}

run().catch((e) => { console.error('RUN ERROR', e); process.exit(1); });
