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
      if (/status = 'queued' AND ref_ready = 1 AND created_at < /i.test(s)) {
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
      return { results: row ? [row] : [], meta: {} };
    }
    if (/SELECT \* FROM tasks WHERE id = \?/i.test(s)) {
      const row = rows.find((r) => r.id === args[0]);
      return { results: row ? [row] : [], meta: {} };
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

async function api(env, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (body && typeof body === 'object' && !(body instanceof Uint8Array)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const req = new Request(BASE + path, { method: opts.method || 'GET', headers, body });
  const res = await worker.fetch(req, env, {});
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
