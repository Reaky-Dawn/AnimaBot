/**
 * runtime/home.js —— 主页页面生命周期
 *
 * 依据：docs/interface-design.md 2.1（主页交互/状态设计）、docs/tech-design.md v2.0 第 2/3.4 节
 * 依赖：service（任务提交/轮询）、ui（组件）、repo（storage 刷新恢复）、types、config
 * 层级：runtime（唯一同时接触 service 与 ui 的胶水层）
 *
 * Sprint 3 职责：提交状态机（初始 → 已提交：输入区/上传区/chips/生成/移除全部锁定变灰，
 *                无"新任务"按钮）；IP_BUSY 提示（AC-P0-11）；防连点。
 * Sprint 4 职责：提交后启动 watchTask() 轮询；5 节点进度条渲染（TaskStatusPanel）；
 *                sessionStorage 刷新恢复进度（NFR-21）；网络异常可见提示；aria-live 播报。
 */

import { EXAMPLE_PROMPTS } from '../config/config.js';
import { submit, watchTask } from '../service/task-service.js';
import { getTaskMeta, getRetryMeta, clearRetryMeta, clearTaskRef } from '../repo/storage.js';
import { initCompliance, showToast } from './shared.js';
import {
  createPromptInput,
  createExampleChips,
  createRefImageUploader,
  createGenerateButton,
  createTaskStatusPanel,
  createAdminNoteDialog,
} from '../ui/components.js';
import { API_ERROR, TASK_STATUS, FAILURE_REASON } from '../types/task.js';

const JUMP_PAUSE_MS = 1500; // 终态停留时长（对应令牌 --duration-jump-pause，Sprint 5 自动跳转）

function initHome() {
  const promptInputEl = document.getElementById('prompt-input');
  const promptCountEl = document.getElementById('prompt-count');
  const promptErrorEl = document.getElementById('prompt-error');
  const chipsEl = document.getElementById('example-chips');
  const refUploaderEl = document.getElementById('ref-uploader');
  const refPreviewEl = document.getElementById('ref-preview');
  const refErrorEl = document.getElementById('ref-error');
  const generateBtnEl = document.getElementById('generate-btn');
  const statusPanelEl = document.querySelector('.status-panel');
  const progressListEl = document.querySelector('.progress');
  const terminalEl = document.getElementById('status-terminal');

  if (!promptInputEl || !generateBtnEl || !progressListEl) {
    console.error('[anima] home init: missing required elements');
    return;
  }

  // 阻止表单默认提交（页面刷新）：Enter 键 / submit 按钮均走前端校验与提交
  const promptForm = document.getElementById('prompt-form');
  if (promptForm) {
    promptForm.addEventListener('submit', (e) => e.preventDefault());
  }

  // 模块内状态：当前参考图数据 / 当前进行中任务 / 轮询句柄 / 进度条组件
  let refFileData = null;
  let activeTask = null;
  let watcher = null;
  let progressPanel = null;

  // ---- 提示词输入 ----
  const promptInput = createPromptInput(promptInputEl, promptCountEl, (msg) => {
    if (msg) {
      promptErrorEl.textContent = msg;
      promptErrorEl.style.color = 'var(--color-error)';
    } else {
      promptErrorEl.textContent = '';
      promptErrorEl.style.color = '';
    }
  });

  // ---- 示例 chips（点击填充 + 聚焦 + 光标置尾） ----
  const exampleChips = createExampleChips(chipsEl, EXAMPLE_PROMPTS, (text) => {
    promptInputEl.value = text;
    promptInput.updateCount();
    promptInputEl.focus();
    promptInputEl.setSelectionRange(text.length, text.length);
  });

  // ---- 参考图上传 ----
  const refUploader = createRefImageUploader(
    refUploaderEl,
    refPreviewEl,
    refErrorEl,
    (fileData) => {
      refFileData = fileData; // {file, dataUrl, width, height, mime} | null
    }
  );

  // ---- 生成按钮（校验 → 提交） ----
  const generateBtn = createGenerateButton(generateBtnEl, () => {
    // 校验（AC-P0-05/06）：先描述，后参考图（参考图在组件内即时校验）
    const promptError = promptInput.validate();
    if (promptError) return;
    if (refErrorEl.textContent) return;

    // ===== 提交 =====
    runSubmit();
  });

  // ---- 提交流程 ----
  async function runSubmit() {
    generateBtn.lock(); // 提交瞬间禁用防连点

    const prompt = promptInputEl.value.trim();
    const refImage = refFileData
      ? { dataUrl: refFileData.dataUrl, mime: refFileData.mime, width: refFileData.width, height: refFileData.height }
      : null;

    // mock 模式 ip_hash：会话级占位（真实模式由 Worker 从 CF-Connecting-IP 计算，前端不传原始 IP）
    const ipHash = getMockIpHash();

    try {
      const task = await submit({ prompt, refImage, ipHash });
      activeTask = task;

      // 提交成功 → 清除重试意图与参考图暂存（新任务起点）
      clearRetryMeta();
      clearTaskRef();

      // 提交成功 → 输入区与上传区整体锁定变灰（用户决策一/二，AC-P0-01）
      lockInputs();
      generateBtn.setDisabled(true); // 保持禁用（锁定态无"新任务"按钮）
      showStatusPanel();

      // Sprint 4：启动状态轮询 + 节点进度条
      startWatching({ id: task.id, taskToken: task.taskToken }, 1, 0);
    } catch (err) {
      generateBtn.unlock(); // 失败恢复按钮（可重试）
      if (err && (err.code === API_ERROR.SENSITIVE_REJECTED || err.code === 'SENSITIVE_REJECTED')) {
        // 政治敏感恒定过滤（Worker POST 返回 400，NFR-10；前端仅提示，无检测逻辑）
        showToast(err.message || '内容不符合要求', 'error');
      } else if (err && (err.code === API_ERROR.IP_BUSY || err.code === 'IP_BUSY')) {
        // AC-P0-11：单 IP 已有进行中任务
        showToast(err.message || '当前已有任务进行中，请等待其结束后再提交', 'error');
      } else {
        showToast('提交失败，请稍后再试', 'error');
        console.error('[anima] submit error', err);
      }
    }
  }

  // ---- 轮询启动（Sprint 4） ----
  /**
   * @param {{id: string, taskToken: string}} taskLike
   * @param {number} initialStage   初始最大节点（刷新恢复时来自 meta）
   * @param {number} initialQueuePos 初始排队位置
   */
  function startWatching(taskLike, initialStage, initialQueuePos) {
    if (watcher) watcher.stop();

    if (!progressPanel) {
      progressPanel = createTaskStatusPanel(progressListEl);
    }
    // 先用已持久化的进度渲染（刷新恢复时立刻可见），首轮轮询会校正状态
    progressPanel.update({
      stage: initialStage || 1,
      queuePos: initialQueuePos || 0,
      status: TASK_STATUS.QUEUED,
    });

    watcher = watchTask({
      id: taskLike.id,
      taskToken: taskLike.taskToken,
      initialStage: initialStage || 1,
      initialQueuePos: initialQueuePos || 0,
      onUpdate: (t) => {
        progressPanel.update({ stage: t.stage, queuePos: t.queuePos, status: t.status });
      },
      onDone: (t) => {
        progressPanel.update({ stage: 5, queuePos: 0, status: TASK_STATUS.DONE });
        // Sprint 5：终态展示 + 停留约 1.5s（--duration-jump-pause）后自动跳转结果页成功态（AC-P0-03）
        showTerminal('生成完成，正在前往结果页…');
        scheduleJump(taskLike.id);
      },
      onFailed: () => {
        progressPanel.update({ stage: 5, queuePos: 0, status: TASK_STATUS.FAILED });
        // Sprint 5：同上跳转结果页失败态（失败原因在结果页呈现，AC-P0-18）
        showTerminal('生成失败，正在前往结果页…');
        scheduleJump(taskLike.id);
      },
      onRejected: (t) => {
        // Sprint 7：rejected 拦截分支——Toast 文案按拒绝原因（NFR-10 口径）、
        // 输入区恢复可编辑（可修改描述重新提交）、不进入节点条、不跳转结果页（AC-P0-20 前端呈现层）
        const reason = t && t.failureReason;
        const copy = reason === FAILURE_REASON.SENSITIVE_REJECTED ? '内容不符合要求' : '内容不符合站点要求';
        showToast(copy, 'error');
        unlockInputs();
        hideStatusPanel();
      },
      onError: (err) => {
        if (err && err.code === API_ERROR.NOT_FOUND) {
          showToast('任务不存在或已过期', 'error');
        } else {
          // 网络异常：不崩溃、退避重试，可见提示（Sprint 4 criterion 6）
          showToast('连接异常，正在重试…', 'error');
        }
      },
    });
  }

  // ---- 锁定输入区（用户决策二：提交后整体锁定变灰，无"新任务"按钮） ----
  function lockInputs() {
    promptInputEl.disabled = true;
    refUploader.setDisabled(true);
    exampleChips.setDisabled(true);
    // 上传预览中的移除按钮禁用
    refPreviewEl.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  }

  /** 解锁输入区（Sprint 7：rejected 后恢复可编辑，AC-P0-20 交互） */
  function unlockInputs() {
    promptInputEl.disabled = false;
    refUploader.setDisabled(false);
    exampleChips.setDisabled(false);
    refPreviewEl.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    generateBtn.unlock();
  }

  /** 隐藏状态区（Sprint 7：rejected 后不保留节点条，新提交会重新显示） */
  function hideStatusPanel() {
    if (statusPanelEl) statusPanelEl.hidden = true;
    if (terminalEl) terminalEl.hidden = true;
  }

  // ---- 状态区显示（Sprint 4 填充 5 节点进度条） ----
  function showStatusPanel() {
    if (statusPanelEl) statusPanelEl.hidden = false;
  }

  // ---- mock ip_hash：会话内稳定（真实模式由 Worker 侧计算） ----
  let cachedIpHash = null;
  function getMockIpHash() {
    if (!cachedIpHash) {
      const stored = sessionStorage.getItem('anima_mock_ip_hash');
      if (stored) { cachedIpHash = stored; return stored; }
      cachedIpHash = 'ip-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('anima_mock_ip_hash', cachedIpHash);
    }
    return cachedIpHash;
  }

  // ---- 终态展示与自动跳转（Sprint 5，用户决策三） ----
  function showTerminal(message) {
    if (!terminalEl) return;
    terminalEl.textContent = message;
    terminalEl.hidden = false;
    if (progressPanel) progressPanel.announce(message);
  }

  function scheduleJump(taskId) {
    // 停留约 1.5s（--duration-jump-pause）后自动跳转结果页；无"查看结果"按钮
    setTimeout(() => {
      location.href = `result.html?task=${taskId}`;
    }, JUMP_PAUSE_MS);
  }

  // ---- 刷新恢复（NFR-21）：同会话刷新后从 sessionStorage 恢复进度并继续轮询 ----
  function tryRestore() {
    const meta = getTaskMeta();
    if (!meta || !meta.taskId || !meta.taskToken) return;

    activeTask = { id: meta.taskId, taskToken: meta.taskToken };
    lockInputs();
    generateBtn.setDisabled(true);
    showStatusPanel();
    startWatching(activeTask, meta.maxStageReached || 1, meta.queuePos || 0);
  }

  // ---- 失败重试回填（AC-P0-18）：结果页"重试"→ 回主页预填原描述 + 参考图 ----
  function tryRetry() {
    const retry = getRetryMeta();
    if (!retry || !retry.prompt) return;
    promptInputEl.value = retry.prompt;
    promptInput.updateCount();
    if (retry.refDataUrl && refUploader.restoreFromDataUrl) {
      refUploader.restoreFromDataUrl(retry.refDataUrl, retry.refMime || 'image/jpeg');
    }
  }

  tryRestore();
  tryRetry();

  // ---- 合规元素（Sprint 6：Cookie 同意条 + Push 关闭） ----
  initCompliance();

  // ---- 站务说明浮层（Sprint 7，AC-P0-22/D5：服务端配置说明、页面无开关） ----
  const adminBtn = document.querySelector('.topbar__admin');
  const adminNoteEl = document.getElementById('admin-note');
  if (adminBtn && adminNoteEl) {
    const adminDialog = createAdminNoteDialog(adminNoteEl);
    adminBtn.addEventListener('click', () => adminDialog.open());
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHome);
} else {
  initHome();
}
