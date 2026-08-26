// 生产环境全链路验证（临时脚本）：建任务 → 引擎处理 → KV 图片读写 → 交付
// 运行：node scripts/prod-verify.mjs（走系统代理环境变量或直连）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://anima-web.chenzilong315.workers.dev';
const ENGINE_KEY = 'LFP4SoGh6O1Xb5nxQzT3fItkjegwVmsaicEMWDJHCvpNduKZ';
const SAMPLE_IMG = readFileSync(join(process.cwd(), 'public', 'assets', 'sample-result.png'));
const IP = '203.0.113.10';

// 环境变量代理：Node 原生 fetch 不走系统代理，需显式 set
// 若本机需要代理访问 workers.dev，请设 HTTPS_PROXY（node 不自带，这里用 undici 全局代理方案，简单起见直接请求）

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

async function req(method, path, { json, body, headers = {}, ip } = {}) {
  const h = { ...headers };
  if (json) h['Content-Type'] = 'application/json';
  if (ip) h['CF-Connecting-IP'] = ip;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: json ? JSON.stringify(json) : body,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

try {
  // 1) health
  const h = await req('GET', '/api/health');
  record('PROD: health 200', h.status === 200 && h.data.ok === true, `v=${h.data.version}`);

  // 2) 建任务（带自定义 IP 头，验证生产是否放行；若被拦则去掉 IP 头重试）
  let created = await req('POST', '/api/tasks', { json: { prompt: 'prod test: starry sky dragon girl', has_ref: false }, ip: IP });
  if (created.status === 403 || created.status === 400) {
    // Cloudflare 可能拒绝客户端伪造 CF-Connecting-IP：去掉该头再试
    created = await req('POST', '/api/tasks', { json: { prompt: 'prod test: starry sky dragon girl', has_ref: false } });
  }
  record('PROD: 建任务 201', created.status === 201 && created.data.id, `status=${created.status}`);
  if (created.status !== 201) { console.log('  body:', JSON.stringify(created.data).slice(0, 300)); process.exit(1); }
  const id = created.data.id;
  const taskToken = created.data.task_token;

  // 3) 引擎 claim
  const claim = await req('GET', '/api/engine/tasks?status=queued&engine_id=prod-verify', { headers: { Authorization: `Bearer ${ENGINE_KEY}` } });
  record('PROD: 引擎 claim 成功', claim.status === 200 && claim.data.task && claim.data.task.id === id, `status=${claim.status}`);

  // 4) 状态推进 + 上传结果图 + done
  const patch = (payload) => req('PATCH', `/api/engine/tasks/${id}`, { json: payload, headers: { Authorization: `Bearer ${ENGINE_KEY}` } });
  await patch({ status: 'prompting', stage: 'prompting' });
  await patch({ status: 'drawing', stage: 'drawing' });
  const pu = await req('GET', `/api/engine/presign-result/${id}`, { headers: { Authorization: `Bearer ${ENGINE_KEY}` } });
  record('PROD: presign-result 返回上传端点', pu.status === 200 && pu.data.url, `url=${pu.data.url}`);
  const up = await req('POST', pu.data.url, { body: SAMPLE_IMG, headers: { Authorization: `Bearer ${ENGINE_KEY}`, 'Content-Type': 'image/png' } });
  record('PROD: 结果图上传 200', up.status === 200, `status=${up.status}`);
  const done = await patch({ status: 'done', result_key: pu.data.key });
  record('PROD: PATCH done 200', done.status === 200, `status=${done.status}`);

  // 5) 前端查询 → result_url
  const gt = await req('GET', `/api/tasks/${id}?token=${encodeURIComponent(taskToken)}`);
  record('PROD: getTask done + result_url', gt.status === 200 && gt.data.status === 'done' && !!gt.data.result_url, `result_url=${gt.data.result_url}`);

  // 6) 下载结果图（KV 图片端点）
  const img = await fetch(`${BASE}${gt.data.result_url}`);
  const imgBuf = Buffer.from(await img.arrayBuffer());
  record('PROD: 结果图下载 PNG 头正确', img.status === 200 && imgBuf[0] === 0x89 && imgBuf[1] === 0x50 && imgBuf[2] === 0x4e && imgBuf[3] === 0x47, `${imgBuf.length}B`);

  // 7) delivered → 重访 404
  const del = await req('POST', `/api/tasks/${id}/delivered`, { json: { task_token: taskToken } });
  record('PROD: delivered 200', del.status === 200);
  const revisit = await req('GET', `/api/tasks/${id}?token=${encodeURIComponent(taskToken)}`);
  record('PROD: delivered 后重访 404', revisit.status === 404, `status=${revisit.status}`);

  // 8) 政治敏感恒定过滤
  const sens = await req('POST', '/api/tasks', { json: { prompt: '组织游行的人群', has_ref: false } });
  record('PROD: 政治敏感 400 SENSITIVE_REJECTED', sens.status === 400 && sens.data.error?.code === 'SENSITIVE_REJECTED');

  // 9) 引擎无 key → 401
  const noAuth = await req('GET', '/api/engine/tasks?status=queued');
  record('PROD: 引擎无密钥 401', noAuth.status === 401, `status=${noAuth.status}`);

} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== ${passed}/${results.length} PASSED =====`);
process.exit(passed === results.length ? 0 : 1);
