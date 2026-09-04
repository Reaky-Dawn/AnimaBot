/**
 * src/index.js —— Anima 生图网站 Worker 实现（KV 存储版，替代 R2）
 *
 * 变更记录（2026-08-23，Sprint 8-KV）：
 *   - 因 Cloudflare R2 启用需绑定国际银行卡（用户不可用），图片存储由 R2 改为 Workers KV：
 *     · 免费额度 1GB / 读 10 万次·天 / 写 1000 次·天 / 单值 ≤25MB（本场景远低于上限）
 *     · presigned URL 直传直下 → 改为 Worker 内图片端点中转（egress 同样免费）
 *     · KV 最终一致性：读端点在未命中时短重试兜底（≈1s），避免引擎上传后前端立即读取 404
 *   - 其余逻辑（D1 任务状态机 / 引擎鉴权 / 政治敏感恒定过滤 / NSFW 开关 / Cron 清理）不变。
 *
 * 依据：docs/tech-design.md v2.0 + docs/platform-decision.md
 * 依赖 binding（wrangler.toml）：DB（D1）、ANIMA_KV（KV）；
 * 环境变量：ENGINE_KEY（secret）、IP_HASH_SALT（[vars]）、NSFW_FILTER_ENABLED（[vars]，默认 true）。
 */

// ===== 常量 =====

/** 政治敏感词（NFR-10：恒定过滤，不可关闭；与 mock 检测词一致，联调回归用） */
const SENSITIVE_WORDS = ['游行', '示威', '政变', '颠覆'];

/** 活跃任务状态（单 IP 并发检查用，AC-P0-11） */
const ACTIVE_STATUSES = ['ref_pending', 'queued', 'prompting', 'prompt_done', 'drawing'];

/** 状态机（只进不退，tech-design 5.1）：引擎回写仅允许正向迁移 */
const FORWARD_ONLY = {
  ref_pending: ['queued', 'failed', 'rejected'],
  queued: ['prompting', 'prompt_done', 'drawing', 'done', 'failed', 'rejected'],
  prompting: ['prompt_done', 'drawing', 'done', 'failed', 'rejected'],
  prompt_done: ['drawing', 'done', 'failed', 'rejected'],
  drawing: ['done', 'failed', 'rejected'],
  done: [],
  failed: [],
  rejected: [],
};

/** KV 图片 key 前缀（按 task_id 隔离，多 IP 并发不混淆） */
const RESULT_KEY_PREFIX = 'result/';
const REF_KEY_PREFIX = 'ref/';

/** KV 最终一致性兜底重试（读图片未命中时轮询，总时长约 1.2s） */
const KV_GET_RETRIES = 6;
const KV_GET_INTERVAL_MS = 200;

// ===== 入口 =====

export default {
  async fetch(request, env, ctx) {
    await ensureSchema(env);
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检（同域前端不需要；引擎为服务端调用，预留）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ---- 探活 ----
    if (path === '/api/health' && request.method === 'GET') {
      return json({
        ok: true,
        service: 'anima-web',
        version: '1.1.0-kv',
        nsfwFilterEnabled: isNsfwEnabled(env),
        ts: Date.now(),
      });
    }

    // ---- 引擎接口（ENGINE_KEY 鉴权） ----
    if (path.startsWith('/api/engine/')) {
      if (!checkEngineAuth(request, env)) {
        return json({ error: { code: 'UNAUTHORIZED', message: '引擎鉴权失败' } }, { status: 401 });
      }
      return handleEngine(request, env, path, url);
    }

    // ---- 前端接口 ----
    if (path.startsWith('/api/tasks')) {
      return handleTasks(request, env, path, url);
    }

    return new Response('Not Found', { status: 404 });
  },

  /** Cron 兜底清理（tech-design 3.3：超 30 分钟悬挂任务 + KV 图片） */
  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    const cutoff = Date.now() - 30 * 60 * 1000;
    // 1) 超时/悬挂任务（非终态且超 30 分钟）
    const stale = await env.DB.prepare(
      `SELECT id, ref_key, result_key FROM tasks
       WHERE created_at < ? AND status NOT IN ('done','failed','rejected')`
    ).bind(cutoff).all();
    // 2) 终态但未交付且超 30 分钟（前端 delivered 异常时兜底）
    const staleDone = await env.DB.prepare(
      `SELECT id, ref_key, result_key FROM tasks
       WHERE updated_at < ? AND status IN ('done','failed','rejected')`
    ).bind(cutoff).all();

    const toDelete = [...stale.results, ...staleDone.results];
    for (const row of toDelete) {
      await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(row.id).run();
      await deleteStoredImages(env, row);
    }
    console.log(`[anima] cron cleanup: ${toDelete.length} tasks deleted`);
  },
};

// ===== 前端接口 =====

async function handleTasks(request, env, path, url) {
  // POST /api/tasks —— 创建任务
  if (path === '/api/tasks' && request.method === 'POST') {
    return createTask(request, env);
  }

  // /api/tasks/{id}/... 子路由
  const m = path.match(/^\/api\/tasks\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) return json({ error: { code: 'NOT_FOUND', message: '任务不存在或已过期' } }, { status: 404 });
  const id = m[1];
  const action = m[2] || null;

  if (action === 'ref' && request.method === 'POST') {
    return uploadRef(request, env, id);
  }
  if (action === 'ref-done' && request.method === 'POST') {
    return refDone(request, env, id);
  }
  if (action === 'delivered' && request.method === 'POST') {
    return delivered(request, env, id);
  }
  if (action === 'image' && request.method === 'GET') {
    return getTaskImage(request, env, id, url);
  }
  if (action === null && request.method === 'GET') {
    return getTask(request, env, id, url);
  }

  return json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, { status: 404 });
}

/** 创建任务：IP 哈希 + 政治敏感恒定过滤 + 单 IP 活跃检查 + 建行（参考图上传端点） */
async function createTask(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const prompt = String(body.prompt || '').trim();
  const hasRef = !!body.has_ref;
  // Sprint 11：任务模式。natural=自然语言（默认，走 LLM Agent）；
  // tags=直接写标签（tags_prompt+natural_prompt 用户直供，不经 LLM 补全，直绘）；
  // upscale=4x 放大（输入图走 ref 上传，引擎用 4x 工作流）。
  const mode = ['tags', 'upscale'].includes(body.mode) ? body.mode : 'natural';
  const tagsPrompt = mode === 'tags' ? String(body.tags_prompt || '').trim() : null;
  const naturalPrompt = mode === 'tags' ? String(body.natural_prompt || '').trim() : null;

  // 校验：描述非空 ≤500（upscale 模式无描述要求；tags 模式可无自然语言，但需标签或自然语言至少其一）
  if (mode === 'natural') {
    if (!prompt) {
      return json({ error: { code: 'VALIDATION', message: '请输入描述' } }, { status: 400 });
    }
    if (prompt.length > 500) {
      return json({ error: { code: 'VALIDATION', message: '描述过长' } }, { status: 400 });
    }
  } else if (mode === 'tags') {
    if (!tagsPrompt && !naturalPrompt) {
      return json({ error: { code: 'VALIDATION', message: '请输入标签提示词或自然语言提示词' } }, { status: 400 });
    }
  }

  // 政治敏感恒定过滤（NFR-10：不受 NSFW_FILTER_ENABLED 影响，不可关闭）
  const checkText = [prompt, tagsPrompt, naturalPrompt].filter(Boolean).join(' ');
  if (SENSITIVE_WORDS.some((w) => checkText.includes(w))) {
    return json({ error: { code: 'SENSITIVE_REJECTED', message: '内容不符合要求' } }, { status: 400 });
  }

  // 单 IP 活跃检查（CF-Connecting-IP → ip_hash，AC-P0-11）
  const ipHash = await ipHashOf(request, env);
  const active = await env.DB.prepare(
    `SELECT id FROM tasks WHERE ip_hash = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
  ).bind(ipHash, ...ACTIVE_STATUSES).first();
  if (active) {
    return json({
      error: { code: 'IP_BUSY', message: '当前已有任务进行中，请等待其结束后再提交' },
    }, { status: 409 });
  }

  const id = crypto.randomUUID();
  const taskToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const now = Date.now();
  // upscale 模式把待放大图当作参考图上传（KV 存 ref/*），引擎据此跑 4x 工作流
  const refKey = hasRef ? `${REF_KEY_PREFIX}${id}.png` : null;

  await env.DB.prepare(
    `INSERT INTO tasks (id, task_token, ip_hash, prompt, mode, tags_prompt, natural_prompt, ref_key, ref_ready, status, result_key, failure_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, taskToken, ipHash, prompt, mode, tagsPrompt, naturalPrompt, refKey,
    hasRef ? 0 : 1,
    hasRef ? 'ref_pending' : 'queued',
    null, null, now, now
  ).run();

  // 参考图上传端点（KV 版：前端 POST 图片字节到 /api/tasks/{id}/ref?token=...）
  const refUploadUrl = hasRef
    ? `/api/tasks/${id}/ref?token=${taskToken}`
    : undefined;

  return json({ id, task_token: taskToken, ref_upload_url: refUploadUrl }, { status: 201 });
}

/** 参考图上传（KV 版）：task_token 校验 → 写 KV → 置 queued 入队 */
async function uploadRef(request, env, id) {
  const token = new URL(request.url).searchParams.get('token') || '';
  const task = await getOwnedTask(env, id, token);
  if (!task) return notFound();
  if (!task.ref_key) {
    return json({ error: { code: 'BAD_REQUEST', message: '该任务无参考图' } }, { status: 400 });
  }
  if (task.status !== 'ref_pending') {
    return json({ ok: true, status: task.status }); // 幂等
  }

  const bytes = await request.arrayBuffer();
  if (!bytes || bytes.byteLength === 0) {
    return json({ error: { code: 'BAD_REQUEST', message: '图片内容为空' } }, { status: 400 });
  }
  if (bytes.byteLength > 20 * 1024 * 1024) {
    return json({ error: { code: 'BAD_REQUEST', message: '参考图过大' } }, { status: 400 });
  }

  await env.ANIMA_KV.put(task.ref_key, bytes);
  await env.DB.prepare(
    `UPDATE tasks SET ref_ready = 1, status = 'queued', updated_at = ? WHERE id = ?`
  ).bind(Date.now(), id).run();
  return json({ ok: true, status: 'queued' });
}

/** 确认参考图上传完成（兼容旧流程；KV 版上传端点已直接入队，此接口幂等保留） */
async function refDone(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const task = await getOwnedTask(env, id, body.task_token);
  if (!task) return notFound();
  if (task.status !== 'ref_pending') {
    return json({ ok: true, status: task.status });
  }
  await env.DB.prepare(
    `UPDATE tasks SET ref_ready = 1, status = 'queued', updated_at = ? WHERE id = ?`
  ).bind(Date.now(), id).run();
  return json({ ok: true, status: 'queued' });
}

/** 查询任务（task_token 校验；done 时返回结果图读取端点） */
async function getTask(request, env, id, url) {
  const token = url.searchParams.get('token') || '';
  const task = await getOwnedTask(env, id, token);
  if (!task) return notFound();

  let queuePos = null;
  if (task.status === 'queued') {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued' AND ref_ready = 1 AND created_at < ? AND id != ?`
    ).bind(task.created_at, id).first();
    queuePos = row ? row.n : 0;
  }

  let resultUrl = null;
  if (task.status === 'done' && task.result_key) {
    // KV 版：结果图经 Worker 端点读取（同域，token 鉴权）
    resultUrl = `/api/tasks/${task.id}/image?token=${token}`;
  }

  return json({
    id: task.id,
    status: task.status,
    stage: task.stage,
    queue_pos: queuePos,
    failure_reason: task.failure_reason,
    engine_log: task.engine_log || null,
    result_url: resultUrl,
  });
}

/** 结果图/参考图读取（KV 版；task_token 鉴权；未命中短重试兜底最终一致性） */
async function getTaskImage(request, env, id, url) {
  const token = url.searchParams.get('token') || '';
  const task = await getOwnedTask(env, id, token);
  if (!task) return notFound();

  // ?kind=ref 取参考图（前端展示预览用），默认取结果图
  const kind = url.searchParams.get('kind') || 'result';
  const key = kind === 'ref' ? task.ref_key : task.result_key;
  if (!key) return json({ error: { code: 'NOT_FOUND', message: '图片不存在' } }, { status: 404 });

  const bytes = await kvGetWithRetry(env, key);
  if (!bytes) return json({ error: { code: 'NOT_FOUND', message: '图片不存在或已过期' } }, { status: 404 });

  return new Response(bytes, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=60', // 交付即删，不宜长缓存
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

/** 交付确认（即用即删主路径：删行 + 删 KV 图片，AC-P0-25） */
async function delivered(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const task = await getOwnedTask(env, id, body.task_token);
  if (!task) return json({ ok: true }); // 已删除视为成功（幂等）
  await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
  await deleteStoredImages(env, task);
  return json({ ok: true });
}

// ===== 引擎接口（ENGINE_KEY 鉴权） =====

async function handleEngine(request, env, path, url) {
  // POST /api/engine/heartbeat —— 引擎心跳上报（供外部自动重启检测）
  // 引擎每次轮询调用；Worker 把心跳时间戳写入 KV，外部触发器据此判断引擎是否存活。
  if (path === '/api/engine/heartbeat' && request.method === 'POST') {
    const engineId = url.searchParams.get('engine_id') || 'engine-1';
    await env.ANIMA_KV.put(`heartbeat/${engineId}`, String(Date.now()));
    return json({ ok: true, ts: Date.now() });
  }

  // GET /api/engine/status —— 引擎存活 + 排队/活跃检测（供 GitHub Actions 自动重启 + notebook 有限保活）
  // 返回：engine_alive（心跳是否在 HEARTBEAT_STALE_MS 内）、queued_count（排队任务数）、
  //       active_count（正在处理中的任务数）。
  if (path === '/api/engine/status' && request.method === 'GET') {
    const engineId = url.searchParams.get('engine_id') || 'engine-1';
    const staleMs = Number(url.searchParams.get('stale_ms') || '180000'); // 默认 3 分钟
    const raw = await env.ANIMA_KV.get(`heartbeat/${engineId}`);
    const heartbeatTs = raw ? Number(raw) : 0;
    const engineAlive = Date.now() - heartbeatTs < staleMs;
    const queued = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued' AND ref_ready = 1`
    ).first();
    const active = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE status IN ('prompting','prompt_done','drawing')`
    ).first();
    return json({
      engine_alive: engineAlive,
      heartbeat_ts: heartbeatTs,
      queued_count: queued ? queued.n : 0,
      active_count: active ? active.n : 0,
      ts: Date.now(),
    });
  }

  // GET /api/engine/tasks?status=queued —— 原子 claim（queued → prompting，engine_id 记录）
  // Sprint 13：单语句原子抢占（UPDATE..RETURNING）。原「SELECT 队首 → 条件 UPDATE」在并发 claim 时
  // 多个引擎/worker 可能读到同一条队首，抢占失败方要空转重试；D1 的 UPDATE 串行执行，
  // 单语句抢占保证每个 queued 任务只会被一个 claimer 拿到，多 worker 并发也不重复派发。
  if (path === '/api/engine/tasks' && request.method === 'GET') {
    const status = url.searchParams.get('status') || 'queued';
    if (status !== 'queued') return json({ task: null });

    const engineId = url.searchParams.get('engine_id') || 'engine-1';
    const claimed = await env.DB.prepare(
      `UPDATE tasks SET status = 'prompting', engine_id = ?, updated_at = ?
       WHERE id = (
         SELECT id FROM tasks
         WHERE status = 'queued' AND ref_ready = 1
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       )
       AND status = 'queued'
       RETURNING id, prompt, mode, tags_prompt, natural_prompt, ref_key`
    ).bind(engineId, Date.now()).run();

    if (!claimed.results || claimed.results.length === 0) return json({ task: null });
    const next = claimed.results[0];

    // 有参考图：返回 Worker 内参考图读取端点（引擎带 ENGINE_KEY 访问）
    const refUrl = next.ref_key ? `/api/engine/ref/${next.id}` : null;
    return json({
      task: {
        id: next.id,
        prompt: next.prompt,
        mode: next.mode || 'natural',
        tags_prompt: next.tags_prompt || null,
        natural_prompt: next.natural_prompt || null,
        ref_url: refUrl,
      },
    });
  }

  // GET /api/engine/ref/{id} —— 引擎下载参考图（KV 版）
  const rm = path.match(/^\/api\/engine\/ref\/([^/]+)$/);
  if (rm && request.method === 'GET') {
    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(rm[1]).first();
    if (!task || !task.ref_key) return json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    const bytes = await kvGetWithRetry(env, task.ref_key);
    if (!bytes) return json({ error: { code: 'NOT_FOUND', message: '参考图不存在' } }, { status: 404 });
    return new Response(bytes, {
      headers: { 'Content-Type': 'image/png', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  }

  // GET /api/engine/presign-result/{id} —— 兼容旧接口：返回结果图上传端点（KV 版改为 Worker 内端点）
  const pm = path.match(/^\/api\/engine\/presign-result\/([^/]+)$/);
  if (pm && request.method === 'GET') {
    const id = pm[1];
    return json({
      url: `/api/engine/result/${id}`,
      key: `${RESULT_KEY_PREFIX}${id}.png`,
    });
  }

  // POST /api/engine/result/{id} —— 引擎上传结果图（KV 版：字节直传 Worker，写入 KV）
  const um = path.match(/^\/api\/engine\/result\/([^/]+)$/);
  if (um && request.method === 'POST') {
    const id = um[1];
    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
    if (!task) return json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    if (task.status !== 'drawing' && task.status !== 'prompt_done' && task.status !== 'prompting') {
      return json({ error: { code: 'BAD_STATE', message: `当前状态不允许上传结果图: ${task.status}` } }, { status: 409 });
    }

    const bytes = await request.arrayBuffer();
    if (!bytes || bytes.byteLength === 0) {
      return json({ error: { code: 'BAD_REQUEST', message: '图片内容为空' } }, { status: 400 });
    }
    if (bytes.byteLength > 20 * 1024 * 1024) {
      return json({ error: { code: 'BAD_REQUEST', message: '结果图过大' } }, { status: 400 });
    }

    const key = `${RESULT_KEY_PREFIX}${id}.png`;
    await env.ANIMA_KV.put(key, bytes);
    // 记录 result_key（供 PATCH done 与 delivered/Cron 清理使用）
    await env.DB.prepare(
      `UPDATE tasks SET result_key = ?, updated_at = ? WHERE id = ?`
    ).bind(key, Date.now(), id).run();
    return json({ ok: true, key });
  }

  // PATCH /api/engine/tasks/{id} —— 状态回写（只进不退校验）
  const tm = path.match(/^\/api\/engine\/tasks\/([^/]+)$/);
  if (tm && request.method === 'PATCH') {
    const id = tm[1];
    const body = await request.json().catch(() => ({}));
    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
    if (!task) return json({ error: { code: 'NOT_FOUND' } }, { status: 404 });

    const newStatus = body.status;
    if (!FORWARD_ONLY[task.status] || !FORWARD_ONLY[task.status].includes(newStatus)) {
      return json({ error: { code: 'INVALID_TRANSITION', message: `状态迁移非法: ${task.status} → ${newStatus}` } }, { status: 422 });
    }

    const stage = body.stage != null ? String(body.stage) : null;
    const resultKey = body.result_key || task.result_key;
    const failureReason = body.failure_reason || null;
    const engineLog = body.engine_log != null ? String(body.engine_log) : (task.engine_log || null);
    await env.DB.prepare(
      `UPDATE tasks SET status = ?, stage = ?, result_key = ?, failure_reason = ?, engine_log = ?, updated_at = ? WHERE id = ?`
    ).bind(newStatus, stage, resultKey, failureReason, engineLog, Date.now(), id).run();

    return json({ id });
  }

  return json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
}

// ===== 工具 =====

function isNsfwEnabled(env) {
  return env.NSFW_FILTER_ENABLED !== 'false';
}

function checkEngineAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const key = env.ENGINE_KEY;
  if (!key) return false; // 未配置 ENGINE_KEY 时引擎接口不可用（安全默认）
  return auth === `Bearer ${key}`;
}

async function ipHashOf(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
  const salt = env.IP_HASH_SALT || 'anima-default-salt';
  const data = new TextEncoder().encode(ip + ':' + salt);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function getOwnedTask(env, id, token) {
  if (!id || !token) return null;
  return env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND task_token = ?').bind(id, token).first();
}

/** KV 读取 + 最终一致性兜底重试（写入后全局可见有秒级延迟） */
async function kvGetWithRetry(env, key) {
  for (let i = 0; i < KV_GET_RETRIES; i++) {
    const value = await env.ANIMA_KV.get(key, 'arrayBuffer');
    if (value) return value;
    if (i < KV_GET_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, KV_GET_INTERVAL_MS));
    }
  }
  return null;
}

/** 删除任务关联的 KV 图片（ref + result） */
async function deleteStoredImages(env, task) {
  const keys = [];
  if (task.ref_key) keys.push(task.ref_key);
  if (task.result_key) keys.push(task.result_key);
  await Promise.all(keys.map((k) => env.ANIMA_KV.delete(k).catch(() => {})));
}

/** 建表（幂等；本地 dev / 首次运行自动初始化） */
async function ensureSchema(env) {
  if (env.__schemaReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      task_token    TEXT NOT NULL,
      ip_hash       TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      mode          TEXT NOT NULL DEFAULT 'natural',
      tags_prompt   TEXT,
      natural_prompt TEXT,
      ref_key       TEXT,
      ref_ready     INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'ref_pending',
      stage         TEXT,
      result_key    TEXT,
      failure_reason TEXT,
      engine_log    TEXT,
      engine_id     TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    )`
  ).run();
  // Sprint 10：旧库补 engine_log 列（D1 基于 SQLite，无 ADD COLUMN IF NOT EXISTS，先查后加）
  const cols = await env.DB.prepare(`PRAGMA table_info(tasks)`).all();
  if (!cols.results.some((c) => c.name === 'engine_log')) {
    await env.DB.prepare(`ALTER TABLE tasks ADD COLUMN engine_log TEXT`).run();
  }
  // Sprint 11：旧库补 mode / tags_prompt / natural_prompt 列
  if (!cols.results.some((c) => c.name === 'mode')) {
    await env.DB.prepare(`ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'natural'`).run();
  }
  if (!cols.results.some((c) => c.name === 'tags_prompt')) {
    await env.DB.prepare(`ALTER TABLE tasks ADD COLUMN tags_prompt TEXT`).run();
  }
  if (!cols.results.some((c) => c.name === 'natural_prompt')) {
    await env.DB.prepare(`ALTER TABLE tasks ADD COLUMN natural_prompt TEXT`).run();
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at)').run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_tasks_ip_active ON tasks(ip_hash) WHERE status IN ('ref_pending','queued','prompting','prompt_done','drawing')`
  ).run();
  env.__schemaReady = true;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(), ...(init.headers ?? {}) },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'X-Robots-Tag': 'noindex, nofollow',
  };
}

function notFound() {
  return json({ error: { code: 'NOT_FOUND', message: '任务不存在或已过期' } }, { status: 404 });
}
