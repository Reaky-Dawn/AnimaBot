/**
 * Sprint 10 QA：Worker engine_log 全链路验证（本地 dev server）
 *
 * 流程：创建任务 → 引擎 claim（prompting）→ PATCH failed 附带 engine_log
 *       → 前端 getTask 返回 engine_log → 断言字段、脱敏（日志中无密钥）
 * 前置：wrangler dev --local 已在 8787 运行。
 */
const BASE = 'http://127.0.0.1:8787';
const ENGINE_KEY = 'anima-local-engine-key-test';

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}

async function run() {
  // 1) 创建任务（无参考图 → queued）
  const createRes = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '一个温柔的动漫少女在樱花树下读书', has_ref: false }),
  });
  const created = await createRes.json();
  check('createTask 201 + task_token', createRes.status === 201 && created.id && created.task_token);

  // 2) 引擎 claim
  const claimRes = await fetch(`${BASE}/api/engine/tasks?status=queued&engine_id=engine-qa`, {
    headers: { Authorization: `Bearer ${ENGINE_KEY}` },
  });
  const claim = await claimRes.json();
  check('engine claim 取到任务', !!claim.task && claim.task.id === created.id);

  // 3) 引擎 PATCH failed + engine_log（模拟 4 槽位全败的异常日志）
  const engineLog = [
    { ts: Date.now() - 8000, elapsed: 0.1, action: 'claim', detail: '任务已接管（提示词构思）' },
    { ts: Date.now() - 5000, elapsed: 3.2, action: 'params_parsed', detail: '尺寸 920x1536' },
    { ts: Date.now() - 2000, elapsed: 6.5, action: 'prompt_generated', detail: '提示词生成完成（tags 120 字符 / natural 80 字符）' },
    { ts: Date.now(), elapsed: 8.1, action: 'failed', detail: 'draw_failed: 所有 LLM 槽位均失败: 槽位1 [https://a.invalid]: connection refused | 槽位2 [https://b.invalid]: timeout | 槽位3 [https://c.invalid]: 401 | 槽位4 [https://d.invalid]: connection refused' },
  ];
  const patchRes = await fetch(`${BASE}/api/engine/tasks/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ENGINE_KEY}` },
    body: JSON.stringify({ status: 'failed', failure_reason: 'draw_failed', engine_log: JSON.stringify(engineLog) }),
  });
  check('PATCH failed 200', patchRes.status === 200);

  // 4) getTask（前端视角）返回 engine_log
  const getRes = await fetch(`${BASE}/api/tasks/${created.id}?token=${created.task_token}`);
  const t = await getRes.json();
  check('getTask failed + engine_log 返回', t.status === 'failed' && t.failure_reason === 'draw_failed');
  check('engine_log 为字符串数组摘要', typeof t.engine_log === 'string' && t.engine_log.includes('所有 LLM 槽位均失败'));

  let logArr = null;
  try { logArr = JSON.parse(t.engine_log); } catch (e) {}
  check('engine_log 可解析为数组', Array.isArray(logArr) && logArr.length === 4);
  check('日志含步骤名/耗时/错误', logArr.some((l) => l.action === 'params_parsed' && l.detail.includes('920x1536'))
    && logArr.some((l) => l.action === 'failed' && l.detail.includes('槽位1')));
  check('日志不含 api_key（无泄露）', !(t.engine_log || '').includes('anima-local') && !(t.engine_log || '').includes('KEY_'));

  // 5) 后端兼容：PATCH 不传 engine_log 时旧引擎不受影响（用新任务验证）
  const createRes2 = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '测试向后兼容', has_ref: false }),
  });
  const c2 = await createRes2.json();
  await fetch(`${BASE}/api/engine/tasks?status=queued&engine_id=engine-qa`, {
    headers: { Authorization: `Bearer ${ENGINE_KEY}` },
  });
  await fetch(`${BASE}/api/engine/tasks/${c2.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ENGINE_KEY}` },
    body: JSON.stringify({ status: 'failed', failure_reason: 'prompt_failed' }),
  });
  const g2 = await (await fetch(`${BASE}/api/tasks/${c2.id}?token=${c2.task_token}`)).json();
  check('不传 engine_log 时返回 null（向后兼容）', g2.status === 'failed' && g2.engine_log === null);

  // 汇总
  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== Sprint 10 engine_log 验证: ${results.length - failed.length}/${results.length} PASS =====`);
  process.exitCode = failed.length ? 1 : 0;
}

run().catch((e) => { console.error('RUN ERROR', e); process.exit(1); });
