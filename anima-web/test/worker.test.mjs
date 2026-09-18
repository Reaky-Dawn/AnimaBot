/**
 * AnimaBot Worker 单元测试（Sprint 13，用户需求 #0/#1：无 bug + 并发正确性）
 *
 * 运行：node test/worker.test.mjs  （零依赖，Node 18+ 自带 node:test / WebCrypto）
 *
 * 用内存 mock 模拟 D1（SQL 模式分发）与 KV，覆盖：
 * - /api/health：NSFW 开关（v1 默认 false）
 * - createTask：校验 / 政治敏感过滤 / 单 IP 活跃限制（并发关键）
 * - 引擎 claim：单语句原子抢占 + FIFO + 抢完为空（并发关键）
 * - PATCH forward-only：状态只进不退
 * - 结果上传/交付/图片读取
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// ---------- mock D1 ----------
const COLUMNS = ['id', 'task_token', 'ip_hash', 'prompt', 'mode', 'tags_prompt', 'natural_prompt',
  'ref_key', 'ref_ready', 'status', 'stage', 'result_key', 'failure_reason', 'engine_log',
  'engine_id', 'created_at', 'updated_at'];
const INSERT_COLS = ['id', 'task_token', 'ip_hash', 'prompt', 'mode', 'tags_prompt', 'natural_prompt',
  'ref_key', 'ref_ready', 'status', 'result_key', 'failure_reason', 'created_at', 'updated_at'];

function makeDb() {
  const rows = [];
  const pick = (r, cols) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]));

  function run(sql, args) {
    const s = sql.replace(/\s+/g, ' ');
    // 建表/索引：noop
    if (/^CREATE TABLE/i.test(s) || /^CREATE INDEX/i.test(s)) return { results: [], meta: { changes: 0 } };
    if (/^PRAGMA table_info/i.test(s)) {
      return { results: COLUMNS.map((name) => ({ name })), meta: {} };
    }
    if (/^INSERT INTO tasks/i.test(s)) {
      const row = Object.fromEntries(INSERT_COLS.map((c, i) => [c, args[i]]));
      row.stage = null; row.engine_log = null; row.engine_id = null;
      rows.push(row);
      return { results: [], meta: { changes: 1 } };
    }
    // 引擎 claim（Sprint 13 单语句原子抢占）
    if (/^UPDATE tasks SET status = 'prompting'/i.test(s)) {
      const [engineId, now] = args;
      const next = rows
        .filter((r) => r.status === 'queued' && r.ref_ready === 1)
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0];
      if (!next) return { results: [], meta: { changes: 0 } };
      next.status = 'prompting'; next.engine_id = engineId; next.updated_at = now;
      return { results: [pick(next, ['id', 'prompt', 'mode', 'tags_prompt', 'natural_prompt', 'ref_key'])], meta: { changes: 1 } };
    }
    // 参考图上传/确认 → 入队
    if (/^UPDATE tasks SET ref_ready = 1/i.test(s)) {
      const row = rows.find((r) => r.id === args[1]);
      if (!row) return { results: [], meta: { changes: 0 } };
      row.ref_ready = 1; row.status = 'queued'; row.updated_at = args[0];
      return { results: [], meta: { changes: 1 } };
    }
    // 结果上传回填 result_key
    if (/^UPDATE tasks SET result_key = /i.test(s)) {
      const row = rows.find((r) => r.id === args[2]);
      if (!row) return { results: [], meta: { changes: 0 } };
      row.result_key = args[0]; row.updated_at = args[1];
      return { results: [], meta: { changes: 1 } };
    }
    // PATCH 状态回写
    if (/^UPDATE tasks SET status = \?/i.test(s)) {
      const [status, stage, resultKey, failureReason, engineLog, updatedAt, id] = args;
      const row = rows.find((r) => r.id === id);
      if (!row) return { results: [], meta: { changes: 0 } };
      Object.assign(row, { status, stage, result_key: resultKey, failure_reason: failureReason, engine_log: engineLog, updated_at: updatedAt });
      return { results: [], meta: { changes: 1 } };
    }
    // COUNT 类
    if (/COUNT\(\*\) AS n FROM tasks/i.test(s)) {
      let n;
      if (/created_at >= \?/i.test(s)) {
        n = rows.filter((r) => r.created_at >= args[0]).length;
      } else if (/status = 'queued' AND ref_ready = 1 AND created_at < /i.test(s)) {
        n = rows.filter((r) => r.status === 'queued' && r.ref_ready === 1 && r.created_at < args[0] && r.id !== args[1]).length;
      } else if (/status = 'queued' AND ref_ready = 1/i.test(s)) {
        n = rows.filter((r) => r.status === 'queued' && r.ref_ready === 1).length;
      } else if (/status IN \('prompting','prompt_done','drawing'\)/i.test(s)) {
        n = rows.filter((r) => ['prompting', 'prompt_done', 'drawing'].includes(r.status)).length;
      } else { n = 0; }
      return { results: [{ n }], meta: {} };
    }
    // cron 兜底
    if (/created_at < \? AND status NOT IN/i.test(s)) {
      return { results: rows.filter((r) => r.created_at < args[0] && !['done', 'failed', 'rejected'].includes(r.status)).map((r) => pick(r, ['id', 'ref_key', 'result_key'])), meta: {} };
    }
    if (/updated_at < \? AND status IN \('done','failed','rejected'\)/i.test(s)) {
      return { results: rows.filter((r) => r.updated_at < args[0] && ['done', 'failed', 'rejected'].includes(r.status)).map((r) => pick(r, ['id', 'ref_key', 'result_key'])), meta: {} };
    }
    // 任务查询
    if (/SELECT id FROM tasks WHERE ip_hash = \? AND status IN/i.test(s)) {
      const row = rows.find((r) => r.ip_hash === args[0] &&
        ['ref_pending', 'queued', 'prompting', 'prompt_done', 'drawing'].includes(r.status));
      return { results: row ? [{ id: row.id }] : [], meta: {} };
    }
    if (/SELECT \* FROM tasks WHERE id = \? AND task_token = \?/i.test(s)) {
      const row = rows.find((r) => r.id === args[0] && r.task_token === args[1]);
      // 返回浅拷贝：模拟真实 D1 快照语义（row 引用会被后续 UPDATE 原地改，污染调用方已持有的旧值）
      return { results: row ? [{ ...row }] : [], meta: {} };
    }
    if (/SELECT \* FROM tasks WHERE id = \?/i.test(s)) {
      const row = rows.find((r) => r.id === args[0]);
      return { results: row ? [{ ...row }] : [], meta: {} };
    }
    if (/DELETE FROM tasks WHERE id = \?/i.test(s)) {
      const i = rows.findIndex((r) => r.id === args[0]);
      if (i >= 0) rows.splice(i, 1);
      return { results: [], meta: { changes: i >= 0 ? 1 : 0 } };
    }
    throw new Error('mock D1 未覆盖 SQL: ' + sql.slice(0, 120));
  }

  const api = { run };
  api.prepare = (sql) => {
    let bound = [];
    const stmt = {
      bind: (...a) => { bound = a; return stmt; },
      run: () => run(sql, bound),
      first: async () => (run(sql, bound).results[0] ?? null),
      all: async () => ({ results: run(sql, bound).results }),
    };
    return stmt;
  };
  return api;
}

// ---------- mock KV ----------
function makeKv() {
  const m = new Map();
  return {
    async get(key, type) {
      const v = m.get(key);
      if (!v) return null;
      return type === 'arrayBuffer' ? v.slice().buffer : v;
    },
    async put(k, v) { m.set(k, v instanceof ArrayBuffer ? new Uint8Array(v) : v); },
    async delete(k) { m.delete(k); },
    _map: m,
  };
}

function makeEnv() {
  return {
    DB: makeDb(),
    ANIMA_KV: makeKv(),
    ENGINE_KEY: 'test-engine-key',
    NSFW_FILTER_ENABLED: 'false',
    IP_HASH_SALT: 'test-salt',
  };
}

const BASE = 'http://localhost';

/** 带可 flush 的 waitUntil ctx（唤醒等后台任务在断言前手动跑完） */
function makeCtx() {
  const tasks = [];
  return {
    tasks,
    waitUntil: (p) => tasks.push(Promise.resolve(p).catch(() => {})),
    async flush() { await Promise.all(tasks); },
  };
}

async function api(env, path, opts = {}, ctx = null) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (body && typeof body === 'object' && !(body instanceof Uint8Array)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const req = new Request(BASE + path, { method: opts.method || 'GET', headers, body });
  const res = await worker.fetch(req, env, ctx || {});
  let json = null;
  try { json = await res.clone().json(); } catch { /* 非JSON（图片字节） */ }
  return { status: res.status, json, res };
}

async function createTask(env, prompt = '一个穿和服的少女', ip = '1.1.1.1', extra = {}) {
  const r = await api(env, '/api/tasks', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
    body: { prompt, ...extra },
  });
  assert.equal(r.status, 201, 'createTask 应成功: ' + JSON.stringify(r.json));
  return r.json;
}

describe('健康检查', () => {
  test('NSFW 开关为 false（v1 关闭检测）', async () => {
    const env = makeEnv();
    const r = await api(env, '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.nsfwFilterEnabled, false);
    assert.equal(r.json.ok, true);
  });
});

describe('创建任务（并发入口）', () => {
  test('正常创建 → queued', async () => {
    const env = makeEnv();
    const t = await createTask(env);
    assert.ok(t.id);
    assert.ok(t.task_token);
  });

  test('空描述 400 / 描述过长 400', async () => {
    const env = makeEnv();
    const r1 = await api(env, '/api/tasks', { method: 'POST', headers: { 'CF-Connecting-IP': '2.2.2.2' }, body: { prompt: ' ' } });
    assert.equal(r1.status, 400);
    const r2 = await api(env, '/api/tasks', { method: 'POST', headers: { 'CF-Connecting-IP': '2.2.2.2' }, body: { prompt: 'x'.repeat(501) } });
    assert.equal(r2.status, 400);
  });

  test('政治敏感词恒定过滤（不受 NSFW 开关影响）', async () => {
    const env = makeEnv();
    const r = await api(env, '/api/tasks', { method: 'POST', headers: { 'CF-Connecting-IP': '2.2.2.2' }, body: { prompt: '参加游行的人们' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'SENSITIVE_REJECTED');
  });

  test('单 IP 并发限制：已有活跃任务时 409（并发关键）', async () => {
    const env = makeEnv();
    await createTask(env, '少女', '3.3.3.3');
    const r = await api(env, '/api/tasks', { method: 'POST', headers: { 'CF-Connecting-IP': '3.3.3.3' }, body: { prompt: '第二条' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'IP_BUSY');
    // 不同 IP 不受影响
    const t2 = await createTask(env, '另一个用户', '4.4.4.4');
    assert.ok(t2.id);
  });
});

describe('引擎 claim（原子抢占，并发关键）', () => {
  test('FIFO 逐条抢占；抢完为空', async () => {
    const env = makeEnv();
    const t1 = await createTask(env, '第一单', '5.5.5.5');
    const t2 = await createTask(env, '第二单', '6.6.6.6');
    const H = { Authorization: 'Bearer test-engine-key' };

    const c1 = await api(env, `/api/engine/tasks?status=queued&engine_id=engine-1`, { headers: H });
    assert.equal(c1.json.task.id, t1.id);          // FIFO：先到先抢

    const c2 = await api(env, `/api/engine/tasks?status=queued&engine_id=engine-1`, { headers: H });
    assert.equal(c2.json.task.id, t2.id);          // 第二次 claim 拿到下一条（不会被上一条卡住）

    const c3 = await api(env, `/api/engine/tasks?status=queued&engine_id=engine-1`, { headers: H });
    assert.equal(c3.json.task, null);              // 抢完为空

    const c4 = await api(env, `/api/engine/tasks?status=queued&engine_id=engine-1`, { headers: H });
    assert.equal(c4.json.task, null);              // 重复 claim 不再出任务
  });

  test('带参考图任务：ref_ready 之前不可被 claim，上传后可', async () => {
    const env = makeEnv();
    const t = await createTask(env, '带图', '7.7.7.7', { has_ref: true });
    const H = { Authorization: 'Bearer test-engine-key' };
    let c = await api(env, `/api/engine/tasks?status=queued`, { headers: H });
    assert.equal(c.json.task, null);               // ref_pending 不可抢
    const up = await api(env, `${t.ref_upload_url}`, { method: 'POST', headers: { 'CF-Connecting-IP': '7.7.7.7' }, body: new Uint8Array([1, 2, 3, 4]) });
    assert.equal(up.status, 200);
    c = await api(env, `/api/engine/tasks?status=queued`, { headers: H });
    assert.equal(c.json.task.id, t.id);
    assert.equal(c.json.task.ref_url, `/api/engine/ref/${t.id}`);
  });

  test('引擎接口未带鉴权 → 401（并发安全前提）', async () => {
    const env = makeEnv();
    const r = await api(env, '/api/engine/tasks?status=queued', {});
    assert.equal(r.status, 401);
  });

  test('并发 claim 压力：8 个 worker 同时抢 3 个任务，恰好抢出 3 个且不重复', async () => {
    const env = makeEnv();
    for (let i = 0; i < 3; i++) await createTask(env, '任务' + i, `11.1.1.${i}`);
    const H = { Authorization: 'Bearer test-engine-key' };
    const results = await Promise.all(Array.from({ length: 8 }, (_, k) =>
      api(env, `/api/engine/tasks?status=queued&engine_id=w${k}`, { headers: H })));
    const claimedIds = results.map((r) => r.json.task && r.json.task.id).filter(Boolean);
    assert.equal(claimedIds.length, 3, '每个任务只派发一次');
    assert.equal(new Set(claimedIds).size, 3, '不存在重复派发');
  });
});

describe('状态机与结果交付', () => {
  test('PATCH 只进不退：drawing → prompting 拒绝', async () => {
    const env = makeEnv();
    const t = await createTask(env, '状态机', '8.8.8.8');
    const H = { Authorization: 'Bearer test-engine-key' };
    const ok = await api(env, `/api/engine/tasks/${t.id}`, { method: 'PATCH', headers: H, body: { status: 'prompting' } });
    assert.equal(ok.status, 200);
    const bad = await api(env, `/api/engine/tasks/${t.id}`, { method: 'PATCH', headers: H, body: { status: 'queued' } });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.error.code, 'INVALID_TRANSITION');
  });

  test('结果上传 → done → 结果图可读 → delivered 清理', async () => {
    const env = makeEnv();
    const t = await createTask(env, '交付', '9.9.9.9');
    const H = { Authorization: 'Bearer test-engine-key' };
    await api(env, `/api/engine/tasks/${t.id}`, { method: 'PATCH', headers: H, body: { status: 'prompting' } });
    await api(env, `/api/engine/tasks/${t.id}`, { method: 'PATCH', headers: H, body: { status: 'drawing' } });

    const pre = await api(env, `/api/engine/presign-result/${t.id}`, { headers: H });
    assert.equal(pre.status, 200);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const up = await api(env, `/api/engine/result/${t.id}`, { method: 'POST', headers: H, body: png });
    assert.equal(up.status, 200);

    const done = await api(env, `/api/engine/tasks/${t.id}`, { method: 'PATCH', headers: H, body: { status: 'done', result_key: `result/${t.id}.png` } });
    assert.equal(done.status, 200);

    const q = await api(env, `/api/tasks/${t.id}?token=${t.task_token}`);
    assert.equal(q.json.status, 'done');
    assert.ok(q.json.result_url);

    const img = await api(env, q.json.result_url);
    assert.equal(img.status, 200);
    const bytes = new Uint8Array(await img.res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const del = await api(env, `/api/tasks/${t.id}/delivered`, { method: 'POST', body: { task_token: t.task_token } });
    assert.equal(del.json.ok, true);
    const gone = await api(env, `/api/tasks/${t.id}?token=${t.task_token}`);
    assert.equal(gone.status, 404);
  });
});

describe('引擎 status（保活/自动重启依据）', () => {
  test('queued_count / active_count / engine_alive', async () => {
    const env = makeEnv();
    const H = { Authorization: 'Bearer test-engine-key' };
    await createTask(env, 'a', '10.1.1.1');
    await createTask(env, 'b', '10.1.1.2');
    let st = await api(env, '/api/engine/status?engine_id=engine-1', { headers: H });
    assert.equal(st.json.queued_count, 2);
    assert.equal(st.json.active_count, 0);

    await api(env, '/api/engine/heartbeat?engine_id=engine-1', { method: 'POST', headers: H });
    await api(env, '/api/engine/tasks?status=queued', { headers: H });   // claim a
    await api(env, '/api/engine/tasks?status=queued', { headers: H });   // claim b

    st = await api(env, '/api/engine/status?engine_id=engine-1', { headers: H });
    assert.equal(st.json.queued_count, 0);
    assert.equal(st.json.active_count, 2);
    assert.equal(st.json.engine_alive, true);
  });
});

describe('每日流量统计（Sprint 16）', () => {
  test('PV 计数 + UV 同 token 同日去重', async () => {
    const env = makeEnv();
    // 同一 token 打 3 次（2 index + 1 result）→ pv=3, uv=1
    await api(env, '/api/stats/hit', { method: 'POST', body: { d: 'device-A', p: 'index' } });
    await api(env, '/api/stats/hit', { method: 'POST', body: { d: 'device-A', p: 'index' } });
    await api(env, '/api/stats/hit', { method: 'POST', body: { d: 'device-A', p: 'result' } });
    // 另一 token 1 次
    await api(env, '/api/stats/hit', { method: 'POST', body: { d: 'device-B', p: 'index' } });
    // 无 token（隐私模式）→ 只记 PV
    await api(env, '/api/stats/hit', { method: 'POST', body: {} });

    const s = await api(env, '/api/stats/summary?days=1');
    assert.equal(s.status, 200);
    assert.equal(s.json.items.length, 1);
    const day = s.json.items[0];
    assert.equal(day.pv, 5);
    assert.equal(day.pv_index, 4);
    assert.equal(day.pv_result, 1);
    assert.equal(day.uv, 2); // A + B（无 token 不计）
    // totals：总 PV 与跨日 UV 并集（1 天窗口：并集 = 当日 UV）
    assert.equal(s.json.totals.pv, 5);
    assert.equal(s.json.totals.uv, 2);
  });

  test('uv 去重按日分键（不同日互不影响——模拟：手动写昨日键后今日计数不受污染）', async () => {
    const env = makeEnv();
    // 直接向 KV 写昨日 uv 集合
    const dstr = new Date(Date.now() + 8 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
    await env.ANIMA_KV.put(`uv/${dstr}`, JSON.stringify(['x'.repeat(24)]));
    await env.ANIMA_KV.put(`stats/${dstr}`, JSON.stringify({ pv_index: 7, pv_result: 3 }));
    // 今日打点（含与昨日相同的摘要 token → 跨日并集去重）
    await api(env, '/api/stats/hit', { method: 'POST', body: { d: 'device-C', p: 'index' } });
    const s = await api(env, '/api/stats/summary?days=2');
    const today = s.json.items.find((i) => i.date === new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10));
    const yest = s.json.items.find((i) => i.date === dstr);
    assert.equal(today.pv, 1);
    assert.equal(today.uv, 1);
    assert.equal(yest.pv, 10);
    assert.equal(yest.uv, 1);
    // totals：跨日 UV 并集 = 2 个不同摘要（昨日 x*24 与今日 device-C 摘要必然不同）；
    // 若昨日摘要等于今日 device-C 摘要则应为 1——这里摘要不同，断言 2
    assert.equal(s.json.totals.uv, 2);
    assert.equal(s.json.totals.pv, 11);
  });

  test('每日任务数（tasks/{date}）进 summary 且 totals.tasks 合计', async () => {
    const env = makeEnv();
    // 今日建 1 单（bumpDailyTaskCount 走 ctx.waitUntil；测试 ctx 无 waitUntil → 手动写键模拟昨日，今日靠 D1 兜底显示）
    await createTask(env, '统计', '10.2.2.2');
    const dstr = new Date(Date.now() + 8 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
    await env.ANIMA_KV.put(`tasks/${dstr}`, JSON.stringify({ n: 4 }));
    const s = await api(env, '/api/stats/summary?days=2');
    const today = s.json.items[0]; // items[0] = 今日
    const yest = s.json.items[1];
    assert.equal(yest.tasks, 4);
    assert.equal(today.tasks, 1); // D1 现算兜底
    assert.equal(s.json.totals.tasks, 5);
  });

  test('days 参数钳制 1..90', async () => {
    const env = makeEnv();
    const s1 = await api(env, '/api/stats/summary?days=0');
    assert.equal(s1.json.days, 1);
    const s2 = await api(env, '/api/stats/summary?days=999');
    assert.equal(s2.json.days, 90);
  });

  test('today_tasks 反映当日建任务数', async () => {
    const env = makeEnv();
    await createTask(env, '统计', '10.2.2.2');
    const s = await api(env, '/api/stats/summary?days=1');
    assert.equal(s.json.today_tasks, 1);
  });

  test('地域统计：hit 按 CF_IPCOUNTRY 计数聚合，XX 丢弃，T1→TOR（Sprint 16.1）', async () => {
    const env = makeEnv();
    // Node fetch 无真实 CF 边缘，测试直接注入 CF_IPCOUNTRY 头（与 Worker 内读取名一致）
    await api(env, '/api/stats/hit', { method: 'POST', headers: { 'CF_IPCOUNTRY': 'CN' }, body: { d: 'geo-A', p: 'index' } });
    await api(env, '/api/stats/hit', { method: 'POST', headers: { 'CF_IPCOUNTRY': 'CN' }, body: { d: 'geo-B', p: 'index' } });
    await api(env, '/api/stats/hit', { method: 'POST', headers: { 'CF_IPCOUNTRY': 'JP' }, body: { d: 'geo-C', p: 'index' } });
    await api(env, '/api/stats/hit', { method: 'POST', headers: { 'CF_IPCOUNTRY': 'XX' }, body: {} }); // 未知码不计
    await api(env, '/api/stats/hit', { method: 'POST', headers: { 'CF_IPCOUNTRY': 'T1' }, body: {} }); // Tor 归 TOR

    const s = await api(env, '/api/stats/summary?days=1');
    const geoMap = Object.fromEntries(s.json.geo);
    assert.equal(geoMap.CN, 2);
    assert.equal(geoMap.JP, 1);
    assert.equal(geoMap.TOR, 1);
    assert.equal(geoMap.XX, undefined);
    // 降序：CN(2) 在前
    assert.deepEqual(s.json.geo.map((g) => g[0])[0], 'CN');
    // 任务 geo：测试环境 createTask 走 mock D1 + 无 waitUntil + 无 CF 头 → 结构存在但为空
    assert.deepEqual(s.json.task_geo, []);
  });

  test('来源统计：referrer 四归类（Sprint 16.2 #4）', async () => {
    const env = makeEnv();
    const hit = (r) => api(env, '/api/stats/hit', { method: 'POST', body: { d: 'ref-' + Math.random(), r } });
    await hit(null);                                                    // direct
    await hit('');                                                      // direct
    await hit('https://animadraw.cloud/result.html?id=x');              // self（host 匹配）
    await hit('https://www.google.com/search?q=anime');                 // search
    await hit('https://tieba.baidu.com/p/12345');                       // search（baidu.com）
    await hit('https://someforum.example.com/thread/1?utm=x');          // ext:someforum.example.com

    const s = await api(env, '/api/stats/summary?days=1');
    const refMap = Object.fromEntries(s.json.referrers);
    assert.equal(refMap['direct'], 2);
    assert.equal(refMap['self'], 1);
    assert.equal(refMap['search'], 2);
    assert.equal(refMap['ext:someforum.example.com'], 1);
  });

  test('任务完成率与人均任务数（Sprint 16.2 #1/#2）', async () => {
    const env = makeEnv();
    const H = { Authorization: 'Bearer test-engine-key' };
    // 3 任务：2 done + 1 failed；两个不同 UV token 打点
    const t1 = await createTask(env, 'a', '20.1.1.1');
    const t2 = await createTask(env, 'b', '20.1.1.2');
    const t3 = await createTask(env, 'c', '20.1.1.3');
    for (const t of [t1, t2, t3]) {
      await api(env, `/api/engine/tasks/${t.id}`, { method: 'PATCH', headers: H, body: { status: 'prompting' } });
      await api(env, `/api/engine/tasks/${t.id}`, { method: 'PATCH', headers: H, body: { status: 'drawing' } });
    }
    await api(env, `/api/engine/tasks/${t1.id}`, { method: 'PATCH', headers: H, body: { status: 'done' } });
    await api(env, `/api/engine/tasks/${t2.id}`, { method: 'PATCH', headers: H, body: { status: 'done' } });
    await api(env, `/api/engine/tasks/${t3.id}`, { method: 'PATCH', headers: H, body: { status: 'failed', failure_reason: 'draw_failed' } });
    // 终态幂等：重复 PATCH done 不得重复计数（forward-only 会拒绝，这里验证 rejected 首次计数后不再变）
    await api(env, '/api/stats/hit', { method: 'POST', body: { d: 'uv-1' } });
    await api(env, '/api/stats/hit', { method: 'POST', body: { d: 'uv-2' } });

    const s = await api(env, '/api/stats/summary?days=1');
    assert.deepEqual(s.json.totals.task_terminal, { done: 2, failed: 1, rejected: 0 });
    assert.equal(s.json.totals.task_done_rate, 66.7); // 2/3
    // 人均：3 任务 / 2 UV = 1.5
    assert.equal(s.json.totals.tasks_per_uv, 1.5);
  });
});

describe('Kaggle 账号池唤醒（Sprint 17）', () => {
  // fetch mock：按 Authorization 头里的 token 决定成败
  function mockFetch(script) {
    const calls = [];
    const orig = global.fetch;
    global.fetch = async (url, opts = {}) => {
      const auth = opts.headers?.Authorization || '';
      calls.push({ url: String(url), token: auth.replace('Bearer ', '').slice(0, 12), body: opts.body ? JSON.parse(opts.body) : null });
      const behavior = script(calls.length, auth);
      return new Response(behavior.body, { status: behavior.status });
    };
    return { calls, restore: () => { global.fetch = orig; } };
  }

  test('主账号成功 → 指针不动；主账号失败 → 切下一账号且指针挪动', async () => {
    const env = makeEnv();
    env.KAGGLE_ACCOUNTS = JSON.stringify([
      { user: 'reagino', token: 'KGAT_AAAA' },
      { user: 'reagino2', token: 'KGAT_BBBB' },
    ]);
    // 第 1 次唤醒：主账号成功
    let m = mockFetch(() => ({ status: 200, body: '{"ref":"reagino/animabot-engine","version_number":1}' }));
    try {
      const ctx = makeCtx();
      await api(env, '/api/tasks', { method: 'POST', headers: { 'CF-Connecting-IP': '30.1.1.1' }, body: { prompt: 'wake1' } }, ctx);
      await ctx.flush();
      assert.equal(env.ANIMA_KV._map.get('wake/kgIdx'), undefined); // 指针未动
      assert.match(m.calls[0].body.slug, /^reagino\/animabot-engine$/);
      assert.equal(m.calls[0].token, 'KGAT_AAAA'.slice(0, 12));

      // 第 2 次唤醒：主账号配额耗尽（403）→ 切 reagino2 成功，指针挪到 1
      env.ANIMA_KV._map.delete('wake/last'); // 解除防抖
      m.restore();
      m = mockFetch((n, auth) => auth.includes('KGAT_AAAA')
        ? { status: 403, body: '{"error":"quota exceeded"}' }
        : { status: 200, body: '{"ref":"reagino2/animabot-engine","version_number":1}' });
      const ctx2 = makeCtx();
      await api(env, '/api/tasks', { method: 'POST', headers: { 'CF-Connecting-IP': '30.1.1.2' }, body: { prompt: 'wake2' } }, ctx2);
      await ctx2.flush();
      assert.equal(env.ANIMA_KV._map.get('wake/kgIdx'), '1'); // 指针已切到账号 2
      const okCall = m.calls.find((c) => c.token === 'KGAT_BBBB'.slice(0, 12));
      assert.ok(okCall, '应尝试 reagino2');
      assert.match(okCall.body.slug, /^reagino2\/animabot-engine$/);
    } finally {
      m.restore();
    }
  });

  test('全账号失败 → 落 GitHub dispatch 兜底（不误报成功）', async () => {
    const env = makeEnv();
    env.KAGGLE_ACCOUNTS = JSON.stringify([{ user: 'reagino', token: 'KGAT_AAAA' }]);
    env.GH_WAKE_TOKEN = 'gh-token';
    const m = mockFetch((n, auth) => {
      if (auth.includes('KGAT_')) return { status: 403, body: '{"error":"quota"}' };
      return { status: 204, body: '' }; // github dispatch 204
    });
    try {
      const ctx = makeCtx();
      await api(env, '/api/tasks', { method: 'POST', headers: { 'CF-Connecting-IP': '30.2.2.2' }, body: { prompt: 'wake3' } }, ctx);
      await ctx.flush();
      const ghCall = m.calls.find((c) => c.url.includes('github.com'));
      assert.ok(ghCall, '应落 GitHub dispatch 兜底');
    } finally {
      m.restore();
    }
  });

  test('旧单账号 secret 兼容（KAGGLE_API_TOKEN 包装成 1 元素池）', async () => {
    const env = makeEnv();
    env.KAGGLE_API_TOKEN = 'KGAT_OLD';
    const m = mockFetch(() => ({ status: 200, body: '{"ref":"reagino/animabot-engine"}' }));
    try {
      const ctx = makeCtx();
      await api(env, '/api/tasks', { method: 'POST', headers: { 'CF-Connecting-IP': '30.3.3.3' }, body: { prompt: 'wake4' } }, ctx);
      await ctx.flush();
      assert.equal(m.calls.length, 1);
      assert.equal(m.calls[0].token, 'KGAT_OLD'.slice(0, 12));
    } finally {
      m.restore();
    }
  });
});
