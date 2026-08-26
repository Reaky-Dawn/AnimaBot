/**
 * types/task.js —— 任务类型常量与状态枚举
 *
 * 依据：docs/tech-design.md v2.0 第 4 节（状态模型）、docs/interface-design.md 2.1.2
 * 依赖：无（纯常量，无副作用）
 * 层级：types（最底层，不引用任何其他层）
 */

// ===== 输入限制常量 =====
export const INPUT_LIMITS = {
  PROMPT_MAX_CHARS: 500,        // 描述最大字数
  REF_IMAGE_MAX_SIZE_BYTES: 5 * 1024 * 1024, // 参考图最大 5MB
  REF_IMAGE_ALLOWED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  REF_IMAGE_ALLOWED_EXTENSIONS: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  REF_IMAGE_COMPRESS_MAX_WIDTH: 1024,  // 压缩后最大宽度
  REF_IMAGE_COMPRESS_QUALITY: 0.8,     // JPEG 压缩质量
};

// ===== 任务状态枚举 =====
export const TASK_STATUS = {
  REF_PENDING: 'ref_pending',       // 参考图上传中（有参考图时的瞬态）
  QUEUED: 'queued',                 // 已入全局队列
  PROMPTING: 'prompting',           // 提示词 Agent 构思中
  PROMPT_DONE: 'prompt_done',       // 提示词已生成
  DRAWING: 'drawing',               // ComfyUI 绘制中
  DONE: 'done',                     // 完成
  FAILED: 'failed',                 // 失败
  REJECTED: 'rejected',             // 内容拒绝
};

// ===== 节点序号映射（5 节点进度条） =====
export const NODE_MAP = [
  { status: TASK_STATUS.QUEUED,       label: '排队中',       stage: 1 },
  { status: TASK_STATUS.PROMPTING,    label: '提示词构思中', stage: 2 },
  { status: TASK_STATUS.PROMPT_DONE,  label: '提示词完成',   stage: 3 },
  { status: TASK_STATUS.DRAWING,      label: '绘制中',       stage: 4 },
  { status: TASK_STATUS.DONE,         label: '完成',         stage: 5 },
  { status: TASK_STATUS.FAILED,       label: '失败',         stage: 5 },
];

// ===== 失败原因枚举 =====
export const FAILURE_REASON = {
  PROMPT_FAILED: 'prompt_failed',
  DRAW_FAILED: 'draw_failed',
  TIMEOUT: 'timeout',
  ENGINE_UNAVAILABLE: 'engine_unavailable',
  NSFW_REJECTED: 'nsfw_rejected',
  SENSITIVE_REJECTED: 'sensitive_rejected',
};

// ===== 错误码常量 =====
export const API_ERROR = {
  IP_BUSY: 'IP_BUSY',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  NETWORK: 'NETWORK',
  SENSITIVE_REJECTED: 'SENSITIVE_REJECTED',
};

/**
 * 状态 → 节点序号（5 节点进度条；ref_pending 视为节点 1）。
 * 依据：NODE_MAP 映射；NODE_MAP 无匹配（如 rejected）时归 1。
 */
export function stageOf(status) {
  const n = NODE_MAP.find((x) => x.status === status);
  return n ? n.stage : 1;
}

/** 是否为终态（停止轮询） */
export function isTerminal(status) {
  return status === TASK_STATUS.DONE || status === TASK_STATUS.FAILED || status === TASK_STATUS.REJECTED;
}

// ===== 任务对象结构（仅定义，非 class） =====
// 任务对象应包含：
//   id: string（UUID）
//   taskToken: string
//   status: TASK_STATUS 值
//   prompt: string
//   hasRefImage: boolean
//   queuePos: number | null
//   failureReason: string | null
//   resultUrl: string | null（done 时 presigned GET URL）
//   createdAt: number（unix ms）