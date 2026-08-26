/**
 * runtime/result.js —— 结果页页面生命周期（Sprint 5）
 *
 * 依据：docs/interface-design.md 2.2（结果页）、docs/tech-design.md v2.0 第 6 节
 * 依赖：service（getTask/watchTask/resolveResultUrl/fetchResultBlob）、repo（storage）、ui（组件）、types
 * 层级：runtime（胶水层）
 *
 * 四态：加载中（占位）→ 成功态（画廊 + 下载 + 灯箱 + 再生成）
 *      ｜ 失败态（失败卡 + 重试 + 再生成）
 *      ｜ 任务无效态（无效卡 + 返回主页，唯一出口）
 */

import {
  getTask,
  watchTask,
  fetchResultBlob,
} from '../service/task-service.js';
import {
  getTaskMeta,
  getTaskRef,
  setRetryMeta,
  clearTaskMeta,
  clearActiveTask,
  clearRetryMeta,
  clearTaskRef,
} from '../repo/storage.js';
import { confirmDelivered } from '../service/task-service.js';
import { initCompliance, showToast } from './shared.js';
import {
  createResultGallery,
  createActionBar,
  createLightbox,
  createInvalidCard,
  createFailCard,
  failureReasonText,
  blobToJpeg,
} from '../ui/components.js';
import { TASK_STATUS, API_ERROR } from '../types/task.js';

function initResult() {
  const taskId = new URLSearchParams(location.search).get('task');
  const meta = getTaskMeta();
  const ref = getTaskRef();

  const galleryEl = document.querySelector('.gallery');
  const failCardEl = document.getElementById('fail-card');
  const actionsEl = document.querySelector('.actions');
  const lightboxEl = document.getElementById('lightbox');
  const invalidCardEl = document.getElementById('invalid-card');

  const gallery = createResultGallery(galleryEl);
  const failCard = createFailCard(failCardEl);
  const actionBar = createActionBar(actionsEl);
  const lightbox = createLightbox(lightboxEl);
  const invalidCard = createInvalidCard(invalidCardEl);

  // 顶部栏任务标识短显（只读，不回显完整标识）
  const badge = document.getElementById('task-badge');
  if (badge) badge.textContent = `任务 #${taskId ? taskId.slice(0, 4) : '----'}`;

  // ---- 参数缺失 / 会话不匹配（直接访问、跨会话、即用即删后重访）→ 任务无效态 ----
  // 说明：result.html?task=<id> 仅对同会话（sessionStorage 持有 taskToken）有效；
  //       NFR-18"请勿外传链接"与此语义一致。
  if (!taskId || !meta || meta.taskId !== taskId || !meta.taskToken) {
    invalidCard.show();
    return;
  }

  let resultUrl = null; // 当前可下载数据源（done 时 result_url；4x 完成后替换）
  let resultBlob = null; // 结果图字节（展示/下载共用；取到即视为"展示就绪"，之后才 delivered）

  // ---- 画廊 → 灯箱 ----
  gallery.onOpenClick((src, alt) => lightbox.open(src, alt));

  // ---- 下载（PNG 直存 / JPEG 用 Canvas 转码；下载中按钮禁用防重复） ----
  actionBar.onDownloadPng(() => doDownload('png'));
  actionBar.onDownloadJpeg(() => doDownload('jpeg'));

  async function doDownload(format) {
    if (!resultBlob) return;
    actionBar.setEnabled(false, false);
    try {
      const out = format === 'jpeg' ? await blobToJpeg(resultBlob) : resultBlob;
      const ext = format === 'jpeg' ? 'jpg' : 'png';
      const a = document.createElement('a');
      const objUrl = URL.createObjectURL(out);
      a.href = objUrl;
      a.download = `anima-${taskId}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
    } catch (e) {
      showToast('下载失败，请稍后再试', 'error');
      console.error('[anima] download error', e);
    } finally {
      actionBar.setEnabled(true, true);
    }
  }

  // ---- 再生成一张（回主页全新输入态，唯一开新任务途径，AC-P0-19） ----
  actionBar.onRegenerate(() => {
    clearTaskMeta();
    clearActiveTask();
    clearRetryMeta();
    clearTaskRef();
    location.href = 'index.html';
  });

  // ---- 失败重试（携带原描述 + 参考图回主页重排，AC-P0-18） ----
  const retryBtn = document.getElementById('retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      // 清掉旧任务标记（否则主页会恢复旧失败任务并再次跳转，形成死循环）
      clearTaskMeta();
      clearActiveTask();
      clearTaskRef();
      setRetryMeta({
        prompt: meta.prompt || '',
        refDataUrl: ref ? ref.dataUrl : null,
        refMime: ref ? ref.mime : null,
      });
      location.href = 'index.html';
    });
  }

  // ---- 加载任务 ----
  async function load() {
    let t;
    try {
      t = await getTask(taskId, meta.taskToken);
    } catch (err) {
      if (err && (err.code === API_ERROR.NOT_FOUND || err.code === 'NOT_FOUND')) {
        invalidCard.show();
      } else {
        showToast('网络异常，正在重试…', 'error');
      }
      return;
    }

    if (t.status === TASK_STATUS.DONE) {
      renderSuccess(t);
    } else if (t.status === TASK_STATUS.FAILED) {
      renderFailure(t);
    } else {
      // 非自动跳转路径（直接访问进行中任务）：占位 + 轮询至终态
      watchTask({
        id: taskId,
        taskToken: meta.taskToken,
        initialStage: t.stage || 1,
        onDone: renderSuccess,
        onFailed: renderFailure,
        onError: (err) => {
          if (err && err.code === API_ERROR.NOT_FOUND) invalidCard.show();
        },
      });
    }
  }

  // ---- 成功态 ----
  async function renderSuccess(t) {
    failCard.hide();
    resultUrl = t.resultUrl;
    try {
      // 取结果图字节（生产：R2 presigned GET 直链，不经 Worker 代理；本地：R2 代理模拟）。
      // blob 取到即"展示就绪"：objectURL 供展示，同一字节供下载（下载即引擎原样字节）。
      const blob = await fetchResultBlob(t.resultUrl);
      resultBlob = blob;
      const objectUrl = URL.createObjectURL(blob);
      gallery.showImage({ src: objectUrl, alt: `AI 生成图片：${meta.descSummary || ''}` });
      actionBar.setEnabled(true, true);
      // 数据即用即删（AC-P0-25 / F17）：展示数据就绪后 delivered（删行 + 删 R2 对象；
      // 重访该任务 → 404 → 任务无效态）
      if (t.status === TASK_STATUS.DONE) {
        confirmDelivered(taskId, meta.taskToken).catch((e) => {
          console.warn('[anima] delivered failed', e);
        });
      }
    } catch (e) {
      console.error('[anima] result load failed', e);
      showToast('结果加载失败，请稍后再试', 'error');
      actionBar.setEnabled(false, false);
    }
  }

  // ---- 失败态 ----
  function renderFailure(t) {
    galleryEl.querySelector('.gallery__frame').hidden = true;
    failCard.show(failureReasonText(t.failureReason), t.engineLog);
    actionBar.setEnabled(false, true); // 下载/放大不可用；再生成可用
  }

  load();

  // ---- 合规元素（Sprint 6：Cookie 同意条 + Push 关闭） ----
  initCompliance();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initResult);
} else {
  initResult();
}
