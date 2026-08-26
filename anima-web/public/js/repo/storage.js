/**
 * repo/storage.js —— localStorage / sessionStorage 封装
 *
 * 依据：docs/tech-design.md v2.0 第 5.3 节（前端存储键表）
 * 依赖：types
 * 层级：repo（仅被 service 调用，不经 ui）
 *
 * 键表：
 *   anima_active_task  localStorage   {taskId, createdAt}            前端单 IP 防重（第一层）
 *   anima_task_meta    sessionStorage {taskId, taskToken, descSummary, prompt,
 *                                      maxStageReached, queuePos}    刷新恢复进度（NFR-21）
 *   anima_task_ref     sessionStorage {dataUrl, mime}                 参考图会话暂存（失败重试回填，AC-P0-18）
 *   cookie-consent     localStorage   '1'                             Cookie 同意条一次性（NFR-14）
 * 注意：taskToken 属会话级敏感凭证，只存 sessionStorage 不进 localStorage（NFR-07 精神）；
 *       参考图 dataUrl 仅存 sessionStorage（同会话、压缩后小体积），不落 localStorage。
 */

// ===== 键名 =====
export const STORAGE_KEYS = {
  ACTIVE_TASK: 'anima_active_task',
  TASK_META: 'anima_task_meta',
  RETRY_META: 'anima_retry_meta',
  TASK_REF: 'anima_task_ref',
  COOKIE_CONSENT: 'cookie-consent',
};

// ===== 通用安全读写 =====
function safeGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 配额/隐私模式失败静默（不阻断主流程）
  }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // 静默
  }
}

function safeSessionGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeSessionSet(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 静默
  }
}

function safeSessionRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // 静默
  }
}

// ===== 单 IP 防重（localStorage） =====
export function setActiveTask(taskId, createdAt) {
  safeSet(STORAGE_KEYS.ACTIVE_TASK, { taskId, createdAt });
}

export function getActiveTask() {
  return safeGet(STORAGE_KEYS.ACTIVE_TASK);
}

export function clearActiveTask() {
  safeRemove(STORAGE_KEYS.ACTIVE_TASK);
}

// ===== 任务元数据（sessionStorage，NFR-21 刷新恢复） =====
export function setTaskMeta(meta) {
  safeSessionSet(STORAGE_KEYS.TASK_META, meta);
}

export function getTaskMeta() {
  return safeSessionGet(STORAGE_KEYS.TASK_META);
}

export function clearTaskMeta() {
  safeSessionRemove(STORAGE_KEYS.TASK_META);
}

// ===== 重试意图（sessionStorage，结果页失败重试回主页预填，AC-P0-18） =====
export function setRetryMeta(meta) {
  safeSessionSet(STORAGE_KEYS.RETRY_META, meta);
}

export function getRetryMeta() {
  return safeSessionGet(STORAGE_KEYS.RETRY_META);
}

export function clearRetryMeta() {
  safeSessionRemove(STORAGE_KEYS.RETRY_META);
}

// ===== 参考图会话暂存（失败重试回填，AC-P0-18；仅同会话、压缩后小体积） =====
export function setTaskRef(ref) {
  safeSessionSet(STORAGE_KEYS.TASK_REF, ref);
}

export function getTaskRef() {
  return safeSessionGet(STORAGE_KEYS.TASK_REF);
}

export function clearTaskRef() {
  safeSessionRemove(STORAGE_KEYS.TASK_REF);
}

// ===== Cookie 同意（NFR-14） =====
export function getCookieConsent() {
  try {
    return localStorage.getItem(STORAGE_KEYS.COOKIE_CONSENT) === '1';
  } catch {
    return false;
  }
}

export function setCookieConsent() {
  try {
    localStorage.setItem(STORAGE_KEYS.COOKIE_CONSENT, '1');
  } catch {
    // 静默
  }
}
