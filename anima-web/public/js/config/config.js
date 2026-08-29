/**
 * config/config.js —— 站点配置（所有可调常量）
 *
 * 依据：docs/tech-design.md v2.0（接口与参数）、docs/interface-design.md
 * 依赖：types（仅常量引用）
 * 层级：config（仅可引用 types，不引用 repo/service/runtime/ui）
 *
 * 注意：本项目无构建工具，config 作为 ES Module 导出常量。
 * 敏感信息（ENGINE_KEY / LLM key / 广告账号）绝不出现在本文件（NFR-07）。
 */

import { INPUT_LIMITS } from '../types/task.js';

export const config = {
  // ===== API 端点（同域 Worker /api/*） =====
  api: {
    // 默认 'mock'（本地开发）；部署时切 'real'。
    // 测试可用 localStorage.setItem('anima_api_mode', 'real'|'mock') 覆盖（供 QA 与部署前联调）。
    mode: (() => {
      try {
        const over = localStorage.getItem('anima_api_mode');
        if (over === 'real' || over === 'mock') return over;
      } catch (e) { /* 存储不可用 */ }
      return 'real'; // 部署默认 real（Worker 同域 /api/*）
    })(),
    // mode='real' 时使用同域相对路径（Worker Static Assets + /api/* 同 origin）
    baseUrl: '',
    endpoints: {
      createTask: '/api/tasks',
      getTask: (id) => `/api/tasks/${id}`,
      refDone: (id) => `/api/tasks/${id}/ref-done`,
      delivered: (id) => `/api/tasks/${id}/delivered`,
      health: '/api/health',
    },
  },

  // ===== 轮询参数（NFR-03） =====
  polling: {
    intervalMs: 1500,        // 网页轮询间隔
    backoffMs: 3000,         // 连续无变化退避间隔
    backoffAfter: 3,         // 连续 N 次无变化后退避
    pauseOnHidden: true,     // visibilitychange 隐藏时暂停
  },

  // ===== 输入限制（引用 types 常量） =====
  input: {
    promptMaxChars: INPUT_LIMITS.PROMPT_MAX_CHARS,
    refImageMaxSizeBytes: INPUT_LIMITS.REF_IMAGE_MAX_SIZE_BYTES,
    refImageAllowedTypes: INPUT_LIMITS.REF_IMAGE_ALLOWED_TYPES,
    compress: {
      maxWidth: INPUT_LIMITS.REF_IMAGE_COMPRESS_MAX_WIDTH,
      quality: INPUT_LIMITS.REF_IMAGE_COMPRESS_QUALITY,
    },
  },

  // ===== 单任务提示文案（AC-P0-11） =====
  singleTask: {
    ipBusyMessage: '当前已有任务进行中，请等待其结束后再提交',
  },

  // ===== 广告（已接入 HillTopAds 真实代码，Sprint 11） =====
  ads: {
    enabled: true,           // 已上线：Popunder + In-Page Push + Banner（代码内联在 HTML）
    mode: 'live',            // 'placeholder' | 'live'（HillTopAds Mainstream 类目）
  },

  // ===== NSFW 拦截（前端只读展示，服务端配置，AC-P0-22） =====
  nsfw: {
    // 前端只渲染服务端回写的 rejected 状态；不执行检测逻辑（NFR-11）
    mode: 'enforced',        // 展示口径：默认拦截（服务端 NSFW_FILTER_ENABLED）
  },
};

// ===== 示例提示词 chips（文案策划定稿，Sprint 2 使用） =====
export const EXAMPLE_PROMPTS = [
  '黄昏下的城市天台，少女回头微笑，风吹起发梢，暖色调',
  '雪夜中的神社鸟居，灯笼微光，宁静治愈的二次元风景',
  '未来都市的雨夜街道，霓虹倒影，科幻感满满的插画',
  '夏日海边，少年与柴犬奔跑在沙滩上，蓝天白云',
  '星空下的魔法图书馆，会飞的书籍环绕，梦幻氛围',
];
