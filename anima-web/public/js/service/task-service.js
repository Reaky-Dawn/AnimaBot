/**
 * service/task-service.js —— 任务业务编排
 *
 * 依据：docs/tech-design.md v2.0（数据流 3.1、单 IP 4.2）、docs/interface-design.md 2.1
 * 依赖：repo（api.js / storage.js）、config、types
 * 层级：service（不触碰 DOM，通过回调/返回值让 runtime 渲染）
 *
 * Sprint 3 职责：submit()——校验（UI 层已完成）→ 建任务 → (有参考图)直传 →
 *                confirmRefDelivered → 写 sessionStorage/localStorage → 返回任务；
 *                IP_BUSY 抛错（409 处理）。
 */

import * as api from '../repo/api.js';
import { setActiveTask, setTaskMeta, setTaskRef, getTaskMeta } from '../repo/storage.js';
import { config } from '../config/config.js';
import { TASK_STATUS, API_ERROR, stageOf, isTerminal } from '../types/task.js';

/**
 * 提交任务。
 * @param {Object} params
 * @param {string} params.prompt        用户描述（已校验非空 ≤500 字）
 * @param {Object|null} params.refImage 参考图数据 {dataUrl, mime, width, height} | null
 * @param {string} params.ipHash        mock 模式的 ip_hash（真实模式由 Worker 从 CF-Connecting-IP 计算，前端不传原始 IP）
 * @param {string} [params.mode]        任务模式：natural（默认）/ tags / upscale
 * @param {string} [params.tagsPrompt]  tags 模式直供标签提示词
 * @param {string} [params.naturalPrompt] tags 模式直供自然语言提示词
 * @returns {Promise<{id, taskToken, status}>}
 * @throws ApiError(IP_BUSY) 当单 IP 已有进行中任务（AC-P0-11）
 */
export async function submit({ prompt, refImage, ipHash, mode, tagsPrompt, naturalPrompt }) {
  const hasRefImage = refImage !== null && refImage !== undefined;

  // 1. 建任务（服务端单 IP 检查在 Worker；mock 模式在 api.js 内）
  let created;
  try {
    created = await api.createTask(prompt, hasRefImage, ipHash, {
      mode, tagsPrompt, naturalPrompt,
    });
  } catch (err) {
    if (err && (err.code === API_ERROR.IP_BUSY || err.code === 'IP_BUSY')) {
      throw err; // 409：前端提示"当前已有任务进行中…"（AC-P0-11）
    }
    throw err;
  }

  // 字段归一化：real API 返回 task_token（snake_case），mock 返回 taskToken（camelCase）
  const taskToken = created.task_token || created.taskToken;

  // 2. 参考图上传：mock 直接挂内存（Sprint 3）；real 走 Worker 上传端点（KV 版，Sprint 8-KV）
  if (hasRefImage) {
    if (config.api.mode === 'mock') {
      api.mockAttachRefData(created.id, refImage.dataUrl);
    } else if (created.ref_upload_url) {
      const ok = await uploadRefToWorker(created.ref_upload_url, refImage.dataUrl, refImage.mime);
      if (!ok) throw new Error('参考图上传失败');
    }
  }
  // 参考图会话暂存（同会话内失败重试回填，AC-P0-18；真实模式 Sprint 8 改引用 R2 refKey）
  if (hasRefImage) {
    setTaskRef({ dataUrl: refImage.dataUrl, mime: refImage.mime });
  }

  // 3. 确认参考图上传完成 → 入队（无参考图时建任务即 queued，此处幂等）
  if (hasRefImage) {
    await api.confirmRefDelivered(created.id, taskToken);
  }

  // 4. 写前端存储
  const createdAt = Date.now();
  setActiveTask(created.id, createdAt); // localStorage：单 IP 防重第一层
  setTaskMeta({
    taskId: created.id,
    taskToken,
    descSummary: prompt.slice(0, 30), // 描述摘要（不含图片内容，NFR-07 精神）
    prompt,                            // 全量描述（≤500 字，重试预填 AC-P0-18 用）
    mode: mode || 'natural',           // Sprint 11：任务模式
    tagsPrompt: tagsPrompt || null,
    naturalPrompt: naturalPrompt || null,
    maxStageReached: 1,
    queuePos: 0,
    hasRefImage,
  }); // sessionStorage：刷新恢复（NFR-21）/ 失败重试（AC-P0-18）

  return {
    id: created.id,
    taskToken,
    status: hasRefImage ? TASK_STATUS.REF_PENDING : TASK_STATUS.QUEUED,
  };
}

/**
 * 将 dataUrl 上传到 Worker 参考图端点（KV 版：POST 图片字节，Worker 写 KV）。
 * @returns {Promise<boolean>}
 */
async function uploadRefToWorker(uploadUrl, dataUrl, mime) {
  try {
    const blob = await (await fetch(dataUrl)).blob(); // dataUrl → Blob
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': mime || blob.type || 'image/png' },
      body: blob,
    });
    return res.ok;
  } catch (e) {
    console.warn('[anima] ref upload to Worker failed', e);
    return false;
  }
}

/**
 * 查询任务（供轮询/结果页）。
 * @param {string} id
 * @param {string} taskToken
 */
export async function getTask(id, taskToken) {
  return api.getTask(id, taskToken);
}

/**
 * 交付确认（即用即删，AC-P0-25）。
 */
export async function confirmDelivered(id, taskToken) {
  await api.deleteTask(id, taskToken);
  // 清理前端标记
  const { clearActiveTask, clearTaskMeta } = await import('../repo/storage.js');
  clearActiveTask();
  clearTaskMeta();
}

/**
 * 解析结果图可展示/可下载的 URL（Sprint 5）。
 * mock 模式：结果页直接引用本地静态样例图（模拟引擎产物）；
 * real 模式：返回 Worker 下发的 R2 presigned GET URL。
 */
export function resolveResultUrl(resultUrl) {
  if (config.api.mode === 'mock') return '/assets/sample-result.png';
  return resultUrl;
}

/**
 * 取结果图二进制（下载用）。
 * mock 模式：fetch 本地样例图；real 模式：fetch presigned URL（R2 直链，NFR-25 免费 egress）。
 */
export async function fetchResultBlob(resultUrl) {
  const url = resolveResultUrl(resultUrl);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`结果图获取失败: ${res.status}`);
  return res.blob();
}

/**
 * 轮询任务状态（Sprint 4）。
 *
 * 启动后立即查一次，然后按 intervalMs 轮询。支持：
 *  - 退避：连续 N 次无变化 → 间隔扩大至 backoffMs
 *  - 暂停：页面隐藏时暂停（visibilitychange），恢复可见时立即补一次 + 恢复
 *  - 只前进：维护 maxStage，stale 或回退的 stage 被忽略
 *  - 持久化：每次 stage 或 queuePos 变化更新 sessionStorage（NFR-21）
 *  - 终态：done/failed/rejected 时停止轮询并回调
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {string} opts.taskToken
 * @param {number} [opts.initialStage]  初始最大节点（刷新恢复时传入，默认 1）
 * @param {number} [opts.initialQueuePos] 初始排队位置（刷新恢复时传入）
 * @param {Function} [opts.onUpdate]     ({status, stage, queuePos, failureReason, resultUrl}) 状态变化时
 * @param {Function} [opts.onDone]       ({status, stage, resultUrl}) 完成时
 * @param {Function} [opts.onFailed]     ({status, stage, failureReason}) 失败时
 * @param {Function} [opts.onRejected]   ({status}) 拒绝时
 * @param {Function} [opts.onError]      (err) 网络异常等
 * @returns {{ stop: Function, pause: Function, resume: Function, isActive: boolean }}
 */
export function watchTask(opts) {
  const { id, taskToken, initialStage: iniStage, initialQueuePos: iniPos } = opts;
  const onUpdate = opts.onUpdate || (() => {});
  const onDone = opts.onDone || (() => {});
  const onFailed = opts.onFailed || (() => {});
  const onRejected = opts.onRejected || (() => {});
  const onError = opts.onError || (() => {});

  let stopped = false;
  let hiddenPaused = false;
  let timer = null;
  let unchanged = 0;
  let maxStage = iniStage || 1;
  let lastQueuePos = iniPos !== undefined ? iniPos : null;
  let lastStatus = null;

  // 持久化元数据
  function persistMeta(partial) {
    try {
      const existing = getTaskMeta() || {};
      setTaskMeta({ ...existing, ...partial });
    } catch (e) { /* 静默 */ }
  }

  function schedule() {
    if (stopped) return;
    const interval = unchanged >= config.polling.backoffAfter ? config.polling.backoffMs : config.polling.intervalMs;
    timer = setTimeout(pollOnce, interval);
  }

  async function pollOnce() {
    if (stopped || hiddenPaused) return;
    try {
      const t = await api.getTask(id, taskToken);
      if (stopped) return;

      const newStage = stageOf(t.status);
      const stageAdvanced = newStage > maxStage;
      const statusChanged = t.status !== lastStatus;
      const queuePosChanged = t.queuePos !== lastQueuePos;

      // 只前进：stage 回退时忽略
      if (stageAdvanced) {
        maxStage = newStage;
        persistMeta({ maxStageReached: maxStage, queuePos: t.queuePos });
      }
      if (queuePosChanged) {
        lastQueuePos = t.queuePos;
        persistMeta({ queuePos: t.queuePos });
      }

      unchanged = (stageAdvanced || statusChanged) ? 0 : unchanged + 1;
      lastStatus = t.status;

      // 状态变化 → 通知 UI
      if (stageAdvanced || statusChanged || queuePosChanged) {
        onUpdate(t);
      }

      // 终态判定
      if (isTerminal(t.status)) {
        stopped = true;
        if (t.status === TASK_STATUS.DONE) onDone(t);
        else if (t.status === TASK_STATUS.FAILED) onFailed(t);
        else onRejected(t);
        return;
      }

      schedule();
    } catch (err) {
      if (stopped) return;
      unchanged++;
      onError(err);
      schedule();
    }
  }

  // visibilitychange 暂停/恢复（NFR-03）
  function onVisibility(e) {
    if (!config.polling.pauseOnHidden) return;
    if (document.hidden) {
      hiddenPaused = true;
      if (timer) { clearTimeout(timer); timer = null; }
    } else {
      hiddenPaused = false;
      if (!stopped) {
        // 恢复可见：立即补一次 + 恢复定时器
        pollOnce();
      }
    }
  }

  document.addEventListener('visibilitychange', onVisibility);

  // 立即首次轮询
  pollOnce();

  return {
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      document.removeEventListener('visibilitychange', onVisibility);
    },
    pause() {
      hiddenPaused = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    resume() {
      if (stopped) return;
      hiddenPaused = false;
      pollOnce();
    },
    get isActive() { return !stopped; },
  };
}
