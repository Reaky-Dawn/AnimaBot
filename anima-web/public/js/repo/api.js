/**
 * repo/api.js —— Worker API 客户端（mock 模式 / 真实同域 /api/*）
 *
 * 依据：docs/tech-design.md v2.0 第 6 节（接口约定）
 * 依赖：config, types
 * 层级：repo（仅可引用 config 与 types，不引用 service/runtime/ui）
 *
 * 开发期用 mock 模式（内存模拟，模拟 201/409/404/状态推进/presign 直链语义）；
 * Sprint 8 联调切换 mode='real'，使用同域 /api/* fetch。
 * 注意：敏感信息（ENGINE_KEY / LLM key）不进前端，NFR-07。
 */

import { config } from '../config/config.js';
import { TASK_STATUS, API_ERROR, FAILURE_REASON, stageOf } from '../types/task.js';

// ===== 内存表（mock 模式用） =====
// 任务表持久化到 localStorage（轻量字段，模拟 Worker 侧 D1 跨页面共享）：
// 使多 IP 并发排队（AC-P0-12）与刷新恢复（NFR-21）在 mock 模式下跨页面可复现。
// 同步策略：localStorage 为权威源，每次公开操作前 mergeFromStorage() 合并其他页面的
// 新增/更新/删除；保存时全量落盘。refDataUrl 属大字段（base64 图），不落盘。
const MOCK_TASKS_KEY = 'anima_mock_tasks';
let mockTasks = new Map(); // id → Task

function loadMockTasks() {
  try {
    const raw = localStorage.getItem(MOCK_TASKS_KEY);
    if (raw) {
      const entries = Object.entries(JSON.parse(raw));
      if (entries.length) mockTasks = new Map(entries);
    }
  } catch (e) { /* 存储不可用则退化为空表 */ }
}

/** 与 localStorage 合并（权威源）：删除本地幽灵、拉取他页新增、按 updatedAt/queuePos 取新 */
function mergeFromStorage() {
  try {
    const raw = localStorage.getItem(MOCK_TASKS_KEY);
    const stored = raw ? JSON.parse(raw) : {};
    const storedIds = new Set(Object.keys(stored));
    [...mockTasks.keys()].forEach((id) => { if (!storedIds.has(id)) mockTasks.delete(id); });
    Object.entries(stored).forEach(([id, s]) => {
      const cur = mockTasks.get(id);
      // queuePos 变化不更新 updatedAt，需单独比较（排队位置跨页同步）
      const queuePosChanged = cur && (s.queuePos || 0) !== (cur.queuePos || 0);
      if (!cur || (s.updatedAt || 0) > (cur.updatedAt || 0) || queuePosChanged) {
        mockTasks.set(id, s);
      }
    });
  } catch (e) { /* 静默 */ }
}

function saveMockTasks() {
  try {
    const slim = {};
    mockTasks.forEach((t, id) => {
      slim[id] = {
        id: t.id, taskToken: t.taskToken, ipHash: t.ipHash, prompt: t.prompt,
        status: t.status, stage: t.stage, queuePos: t.queuePos,
        refKey: t.refKey, refReady: t.refReady, resultKey: t.resultKey,
        failureReason: t.failureReason, resultUrl: t.resultUrl,
        createdAt: t.createdAt, updatedAt: t.updatedAt,
      };
    });
    localStorage.setItem(MOCK_TASKS_KEY, JSON.stringify(slim));
  } catch (e) { /* 配额失败静默 */ }
}
loadMockTasks();
// 活动 IP 集持久化到 localStorage：模拟服务端 D1 状态跨页面/刷新保留（真实模式由 Worker 侧持有），
// 使单 IP 限制（AC-P0-11）在 mock 模式下跨页面可复现。
const MOCK_ACTIVE_IPS_KEY = 'anima_mock_active_ips';

function loadMockActiveIps() {
  try {
    const raw = localStorage.getItem(MOCK_ACTIVE_IPS_KEY);
    if (raw) return new Map(Object.entries(JSON.parse(raw)));
  } catch (e) { /* 存储不可用则退化为内存态 */ }
  return new Map();
}
function saveMockActiveIps() {
  try {
    localStorage.setItem(MOCK_ACTIVE_IPS_KEY, JSON.stringify(Object.fromEntries(mockActiveIps)));
  } catch (e) { /* 存储不可用则保持内存态 */ }
}
let mockActiveIps = loadMockActiveIps(); // ip_hash → taskId

function refreshActiveIps() {
  mockActiveIps = loadMockActiveIps();
}

// ===== Mock 引擎模拟（Sprint 4：自动推进 + 串行处理 + 网络异常开关） =====
// 模拟"引擎容量 = 1"的串行处理：同一时刻只有 1 个任务处于 prompting/prompt_done/drawing，
// 其余 queued 任务保持排队（queue_pos 由 recalcQueuePos 实时计算）。
// 任务表持久化到 localStorage，支持多页面共享（模拟 D1 跨页语义）。
// 引擎每页独立 tick，通过 updatedAt 防抖避免多页双推进（ack 间隔 ≥ ENGINE_TICK_MS）。
const ENGINE_TICK_MS = 1500; // 引擎处理步进（与网页轮询间隔一致，便于观察）
let engineTimer = null;
let engineAutoAdvance = true;   // 默认开启（演示/QA 直观）；测试可关闭后手动 mockAdvanceTask
let processingId = null;        // 当前正在处理（非排队）的任务 id（per-page 缓存，引擎 tick 重新读取）
let mockNetworkError = false;   // 模拟网络异常（QA 验证轮询容错）
let nsfwFilterEnabled = true;   // 模拟 Worker 侧 NSFW_FILTER_ENABLED（默认 true，站长部署时可关；
                                // 政治敏感拦截不受此开关影响，Worker POST 恒定过滤——NFR-10）

/**
 * 模拟引擎内容检查（Sprint 7，mock 模拟层）。
 * 红线语义：真实检测对象是引擎输出的提示词标签（tags_prompt），参考图不参与检测；
 *           真实判定在 Kaggle 引擎/Worker 侧，前端只感知 rejected 状态（NFR-11）。
 * 本函数仅以用户描述关键词模拟"引擎回写 rejected"，Sprint 8 联调时随 mock 一并移除。
 */
function mockSimulateEngineCheck(prompt) {
  if (!prompt) return null;
  const NSFW_WORDS = ['裸', '色情', '性交', '淫'];            // 受 NSFW_FILTER_ENABLED 开关控制
  const SENSITIVE_WORDS = ['游行', '示威', '政变', '颠覆'];   // 恒定拦截，不可关闭（NFR-10）
  if (SENSITIVE_WORDS.some((w) => prompt.includes(w))) {
    return FAILURE_REASON.SENSITIVE_REJECTED;
  }
  if (nsfwFilterEnabled && NSFW_WORDS.some((w) => prompt.includes(w))) {
    return FAILURE_REASON.NSFW_REJECTED;
  }
  return null;
}

/**
 * 模拟引擎拒绝回写（QA 验证 rejected 终态，Sprint 7）。
 * 与失败一样：任务结束、释放该 IP；stage 不推进（rejected 不进入节点条）。
 */
export function mockRejectTask(id, reason = 'nsfw_rejected') {
  mergeFromStorage();
  const task = mockTasks.get(id);
  if (!task) return false;
  if (processingId === id) processingId = null;
  task.status = TASK_STATUS.REJECTED;
  task.stage = stageOf(TASK_STATUS.REJECTED);
  task.failureReason = reason;
  task.updatedAt = Date.now();
  releaseActiveIp(task);
  recalcQueuePos();
  return true;
}

/**
 * 模拟 Worker 侧 NSFW_FILTER_ENABLED 配置变更（QA criterion 6：配置变更对新任务生效）。
 * 注意：政治敏感拦截不受此开关影响。
 */
export function mockSetNsfwFilterEnabled(enabled) {
  nsfwFilterEnabled = !!enabled;
}

function ensureEngineStarted() {
  if (engineTimer) return;
  engineTimer = setInterval(engineTick, ENGINE_TICK_MS);
}

function engineTick() {
  if (!engineAutoAdvance) return;
  mergeFromStorage();
  // 重读 processingId 任务（跨页可能被其他页推进了）
  const processing = processingId ? mockTasks.get(processingId) : null;
  // 正在处理中：推进一步（防抖：距上次更新不足 1 tick 时跳过，避免多页并发双推进）
  if (processing && processing.status !== TASK_STATUS.DONE && processing.status !== TASK_STATUS.FAILED) {
    if (Date.now() - processing.updatedAt < ENGINE_TICK_MS) return;
    advanceOneStep(processing);
    if (processing.status === TASK_STATUS.DONE || processing.status === TASK_STATUS.FAILED) {
      processingId = null;
      recalcQueuePos();
    }
    return;
  }
  // 认领下一个队首任务（FIFO：createdAt 最早且 refReady）
  processingId = null;
  const next = [...mockTasks.values()]
    .filter((t) => t.status === TASK_STATUS.QUEUED && t.refReady)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (next && Date.now() - next.updatedAt >= ENGINE_TICK_MS * 0.8) {
    processingId = next.id;
    advanceOneStep(next); // queued → prompting
  }
}

/** 状态机推进一步（只前进）。终态（done/failed）时释放该 IP 的活跃占用。
 *  注意：调用者需确保已执行 mergeFromStorage()，本函数不重复 merge（避免引用失效）。 */
function advanceOneStep(task) {
  const statusFlow = [
    TASK_STATUS.QUEUED,
    TASK_STATUS.PROMPTING,
    TASK_STATUS.PROMPT_DONE,
    TASK_STATUS.DRAWING,
    TASK_STATUS.DONE,
  ];
  const idx = statusFlow.indexOf(task.status);
  if (idx === -1 || idx >= statusFlow.length - 1) return false;
  task.status = statusFlow[idx + 1];
  task.stage = stageOf(task.status);
  task.updatedAt = Date.now();
  if (task.status === TASK_STATUS.DONE) releaseActiveIp(task);
  saveMockTasks();
  // 任务离开/进入队列后重算排队位置（他任务 queuePos 随之变化）
  recalcQueuePos();
  return true;
}

function releaseActiveIp(task) {
  refreshActiveIps();
  if (task.ipHash) {
    mockActiveIps.delete(task.ipHash);
    saveMockActiveIps();
  }
}

// ===== 工具函数 =====
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function token() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// ===== 接口定义 =====

/**
 * 创建任务。
 * 返回 {id, taskToken, refPresign?} 或抛 ApiError(IP_BUSY)。
 * 参考图：返回 presigned PUT URL 语义（mock 返回假 URL，Sprint 3 仅存 dataUrl 在内存）。
 */
export async function createTask(prompt, hasRefImage, ipHash) {
  if (config.api.mode === 'mock') {
    return mockCreateTask(prompt, hasRefImage, ipHash);
  }
  return realCreateTask(prompt, hasRefImage);
}

/**
 * 查询任务。
 * 返回 {id, status, stage?, queuePos?, failureReason?, resultUrl?} 或抛 ApiError(NOT_FOUND)。
 */
export async function getTask(id, taskToken) {
  if (config.api.mode === 'mock') {
    return mockGetTask(id, taskToken);
  }
  return realGetTask(id, taskToken);
}

/**
 * 确认参考图上传完成。
 */
export async function confirmRefDelivered(id, taskToken) {
  if (config.api.mode === 'mock') {
    return mockConfirmRefDelivered(id, taskToken);
  }
  return realConfirmRefDelivered(id, taskToken);
}

/**
 * 交付确认（即用即删）。
 */
export async function deleteTask(id, taskToken) {
  if (config.api.mode === 'mock') {
    return mockDeleteTask(id, taskToken);
  }
  return realDeleteTask(id, taskToken);
}

// ===== Mock 实现 =====

function mockCreateTask(prompt, hasRefImage, ipHash) {
  mergeFromStorage();
  refreshActiveIps();
  // 单 IP 活跃检查（模拟服务端 409，AC-P0-11）
  if (mockActiveIps.has(ipHash)) {
    const err = new Error(config.singleTask.ipBusyMessage);
    err.code = API_ERROR.IP_BUSY;
    throw err;
  }

  const id = uuid();
  const taskToken = token();
  const now = Date.now();

  const task = {
    id,
    taskToken,
    ipHash: ipHash || 'mock-ip',
    prompt,
    status: hasRefImage ? TASK_STATUS.REF_PENDING : TASK_STATUS.QUEUED,
    stage: stageOf(hasRefImage ? TASK_STATUS.REF_PENDING : TASK_STATUS.QUEUED),
    queuePos: 0,
    refKey: hasRefImage ? `ref/${id}.png` : null,
    refReady: hasRefImage ? 0 : 1,
    resultKey: null,
    failureReason: null,
    resultUrl: null,
    createdAt: now,
    updatedAt: now,
  };

  mockTasks.set(id, task);
  // 记录活跃 IP（ref_pending / queued 及以上状态都算活跃）
  mockActiveIps.set(ipHash, id);
  saveMockActiveIps();

  // 计算队列位置
  recalcQueuePos();

  // 启动引擎模拟（自动推进 queued 任务）
  ensureEngineStarted();

  // 模拟引擎内容检查（回写 rejected；前端经轮询感知，Sprint 7 mock 模拟层）
  const rejection = mockSimulateEngineCheck(prompt);
  if (rejection) {
    mockRejectTask(id, rejection);
  }

  return {
    id,
    taskToken,
    refPresign: hasRefImage ? { url: `mock-presign-put/${id}`, key: task.refKey } : undefined,
  };
}

function mockGetTask(id, taskToken) {
  mergeFromStorage();
  // 模拟网络异常（QA 验证轮询容错，AC-criterion 6）
  if (mockNetworkError) {
    const err = new Error('网络异常');
    err.code = API_ERROR.NETWORK;
    throw err;
  }

  const task = mockTasks.get(id);
  if (!task) {
    const err = new Error('任务不存在或已过期');
    err.code = API_ERROR.NOT_FOUND;
    throw err;
  }
  if (task.taskToken !== taskToken) {
    const err = new Error('任务标识不匹配');
    err.code = API_ERROR.NOT_FOUND;
    throw err;
  }

  return {
    id: task.id,
    status: task.status,
    stage: task.stage || stageOf(task.status),
    queuePos: task.queuePos,
    failureReason: task.failureReason,
    resultUrl: task.status === TASK_STATUS.DONE ? `mock-presign-get/${id}` : null,
  };
}

function mockConfirmRefDelivered(id, taskToken) {
  mergeFromStorage();
  const task = mockTasks.get(id);
  if (!task || task.taskToken !== taskToken) return;
  task.refReady = 1;
  task.status = TASK_STATUS.QUEUED;
  task.stage = stageOf(TASK_STATUS.QUEUED);
  task.updatedAt = Date.now();
  recalcQueuePos();
  ensureEngineStarted();
  return { ok: true };
}

function mockDeleteTask(id, taskToken) {
  mergeFromStorage();
  const task = mockTasks.get(id);
  if (!task) return;
  if (task.taskToken !== taskToken) return;
  if (processingId === id) processingId = null;
  mockTasks.delete(id);
  refreshActiveIps();
  mockActiveIps.delete(task.ipHash);
  saveMockActiveIps();
  recalcQueuePos();
}

// ===== Mock 辅助：队列位置计算 =====
// 注意：不在此处 merge（调用者已同步，避免 Map 引用被替换）
function recalcQueuePos() {
  const queued = [...mockTasks.values()]
    .filter((t) => t.status === TASK_STATUS.QUEUED && t.refReady)
    .sort((a, b) => a.createdAt - b.createdAt);
  queued.forEach((t, i) => { t.queuePos = i; });
  saveMockTasks();
}

// ===== Mock 辅助：模拟引擎推进（供 Sprint 4 轮询测试使用） =====
/**
 * 手动推进一个任务到下一状态（测试/调试用）。
 * 注意：不走队列认领（仅供 engineAutoAdvance=false 时手动驱动单任务状态机）。
 */
export function mockAdvanceTask(id) {
  mergeFromStorage();
  const task = mockTasks.get(id);
  if (!task) return false;
  return advanceOneStep(task);
}

/**
 * 开/关 mock 引擎自动推进（默认开）。
 * 测试需确定性时：先 mockSetEngineAutoAdvance(false)，用 mockAdvanceTask 手动推进。
 */
export function mockSetEngineAutoAdvance(enabled) {
  engineAutoAdvance = !!enabled;
}

/**
 * 模拟网络异常：开启后 getTask 抛 NETWORK 错误（QA 验证轮询不崩溃 + 退避重试）。
 */
export function mockSetNetworkError(enabled) {
  mockNetworkError = !!enabled;
}

/**
 * 模拟引擎失败回写（QA 验证失败终态）。
 */
export function mockFailTask(id, reason = 'draw_failed') {
  mergeFromStorage();
  const task = mockTasks.get(id);
  if (!task) return false;
  if (processingId === id) processingId = null;
  task.status = TASK_STATUS.FAILED;
  task.stage = stageOf(TASK_STATUS.FAILED);
  task.failureReason = reason;
  task.updatedAt = Date.now();
  releaseActiveIp(task);
  recalcQueuePos();
  return true;
}

/** 当前 mock 任务数 / 排队位置（QA 断言用） */
export function mockStats() {
  mergeFromStorage();
  return {
    tasks: mockTasks.size,
    queuePos: [...mockTasks.values()].map((t) => ({ id: t.id, status: t.status, queuePos: t.queuePos })),
  };
}

// ===== Mock 辅助：附加参考图数据（模拟直传 R2，Sprint 3 提交链路用） =====
/**
 * mock 模式下将参考图 dataUrl 挂到内存任务（模拟 presigned PUT 直传后 Worker 侧持有）。
 * 仅供 service 层在提交链路调用。
 */
export function mockAttachRefData(id, dataUrl) {
  mergeFromStorage();
  const task = mockTasks.get(id);
  if (task) {
    task.refDataUrl = dataUrl;
  }
}

// ===== 真实 API 实现（Sprint 8：同域 /api/* fetch，Worker 完整实现） =====

async function realCreateTask(prompt, hasRefImage) {
  const res = await fetch(config.api.endpoints.createTask, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, has_ref: hasRefImage }),
  });
  if (res.status === 201) return res.json();
  if (res.status === 409) {
    const data = await res.json();
    const err = new Error(data.error?.message || config.singleTask.ipBusyMessage);
    err.code = API_ERROR.IP_BUSY;
    throw err;
  }
  if (res.status === 400) {
    const data = await res.json();
    const err = new Error(data.error?.message || '请求参数错误');
    // 政治敏感恒定过滤（Worker POST 不可关，NFR-10）
    if (data.error?.code === 'SENSITIVE_REJECTED') {
      err.code = API_ERROR.SENSITIVE_REJECTED;
    } else {
      err.code = API_ERROR.VALIDATION;
    }
    throw err;
  }
  throw new Error(`Create task failed: ${res.status}`);
}

async function realGetTask(id, taskToken) {
  const url = `${config.api.endpoints.getTask(id)}?token=${encodeURIComponent(taskToken)}`;
  const res = await fetch(url);
  if (res.status === 200) {
    const t = await res.json();
    // 字段归一化：Worker 返回 snake_case → 前端统一 camelCase（与 mockGetTask 输出一致）
    return {
      id: t.id,
      status: t.status,
      stage: t.stage,
      queuePos: t.queue_pos,
      failureReason: t.failure_reason,
      engineLog: t.engine_log,
      resultUrl: t.result_url,
    };
  }
  if (res.status === 404) {
    const err = new Error('任务不存在或已过期');
    err.code = API_ERROR.NOT_FOUND;
    throw err;
  }
  throw new Error(`Get task failed: ${res.status}`);
}

async function realConfirmRefDelivered(id, taskToken) {
  const res = await fetch(config.api.endpoints.refDone(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_token: taskToken }),
  });
  if (res.status === 200) return res.json();
  throw new Error(`Ref-done failed: ${res.status}`);
}

async function realDeleteTask(id, taskToken) {
  const res = await fetch(config.api.endpoints.delivered(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_token: taskToken }),
  });
  if (res.status === 200) return res.json();
  throw new Error(`Delivered failed: ${res.status}`);
}

// ===== 自定义错误类 =====
export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}