/**
 * runtime/home.js —— 主页页面生命周期（Sprint 11：多标签页重构）
 *
 * Sprint 11 变更：
 *  - 顶部标签栏 5 个子页：自然语言生成 / 标签提示词 / 提取元数据 / 4x 放大 / 使用示例
 *  - 删除 5 节点进度条「查看进程」功能（出于流量考虑）：提交后仅显示简单「生成中…」，
 *    失败时在结果页提示简要「卡在 XX 步」；完整错误明细在 Kaggle 侧独立 error log 落盘。
 *  - 删除右上角 ⓘ 站务说明（不对用户做 NSFW 说明）。
 *  - 「使用参考图」改为选项框，勾选才显示上传区。
 *  - 新增「标签提示词」子页（直写标签直绘，不经 LLM 补全）与「4x 放大」子页。
 *
 * 依赖：service（任务提交/轮询）、ui（组件）、repo（storage）、types、config
 */

import { EXAMPLE_PROMPTS } from '../config/config.js';
import { submit, watchTask } from '../service/task-service.js';
import { getTaskMeta, getRetryMeta, clearRetryMeta, clearTaskRef } from '../repo/storage.js';
import { initCompliance, showToast } from './shared.js';
import {
  createPromptInput,
  createExampleChips,
  createRefImageUploader,
  parsePngMetadata,
} from '../ui/components.js';
import { API_ERROR } from '../types/task.js';

const JUMP_PAUSE_MS = 1500;

function initHome() {
  // ===== 标签栏切换 =====
  const tabButtons = Array.from(document.querySelectorAll('.tab'));
  const panels = Array.from(document.querySelectorAll('.tab-panel'));
  const tabById = new Map(tabButtons.map((b) => [b.dataset.tab, b]));
  const panelById = new Map(panels.map((p) => [p.dataset.panel, p]));

  function switchTab(name) {
    tabButtons.forEach((b) => b.classList.toggle('tab--active', b.dataset.tab === name));
    panels.forEach((p) => p.classList.toggle('tab-panel--active', p.dataset.panel === name));
  }
  tabButtons.forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  // ===== 共享状态：进行中任务 / 轮询 / 状态区 =====
  const statusPanelEl = document.querySelector('.status-panel');
  const statusMsgEl = document.getElementById('status-msg');
  const terminalEl = document.getElementById('status-terminal');
  let watcher = null;
  let activeTask = null;
  let busy = false; // 全局忙碌标志：任一标签提交后锁定全部输入，防连点
  let upscaleHasFile = false; // upscale 子页是否已选图（按钮启用依据）

  function getMockIpHash() {
    let h = sessionStorage.getItem('anima_mock_ip_hash');
    if (!h) { h = 'ip-' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('anima_mock_ip_hash', h); }
    return h;
  }

  function showStatus(msg) {
    if (statusMsgEl) statusMsgEl.textContent = msg;
    if (statusPanelEl) statusPanelEl.hidden = false;
    if (terminalEl) terminalEl.hidden = true;
  }
  function hideStatus() {
    if (statusPanelEl) statusPanelEl.hidden = true;
    if (terminalEl) terminalEl.hidden = true;
  }
  function lockAllTabs() {
    busy = true;
    document.querySelectorAll('.prompt-input').forEach((t) => { t.disabled = true; });
    document.querySelectorAll('.uploader').forEach((u) => { u.setAttribute('aria-disabled', 'true'); });
    document.querySelectorAll('#natural-btn, #tags-btn, #upscale-btn').forEach((b) => { b.disabled = true; });
  }
  function unlockAllTabs() {
    busy = false;
    document.querySelectorAll('.prompt-input').forEach((t) => { t.disabled = false; });
    document.querySelectorAll('.uploader').forEach((u) => { u.removeAttribute('aria-disabled'); });
    document.querySelectorAll('#natural-btn, #tags-btn').forEach((b) => { b.disabled = false; });
    // upscale 按钮仅在已选图时启用
    const upBtn = document.getElementById('upscale-btn');
    if (upBtn) upBtn.disabled = !upscaleHasFile;
  }

  /**
   * 提交后启动轮询：仅检测终态（done → 跳结果页成功；failed → 跳结果页失败）。
   * 不做 5 节点进度展示（Sprint 11）。
   */
  function startWatching(taskLike) {
    if (watcher) watcher.stop();
    let recoverErrorCount = 0; // 连续网络异常计数（超出则解锁，避免永久"生成中"）
    const MAX_RECOVER_ERRORS = 6;

    watcher = watchTask({
      id: taskLike.id,
      taskToken: taskLike.taskToken,
      onDone: () => {
        showStatus('生成完成，正在前往结果页…');
        scheduleJump(taskLike.id);
      },
      onFailed: () => {
        showStatus('生成失败，正在前往结果页…');
        scheduleJump(taskLike.id);
      },
      onRejected: (t) => {
        // rejected：提示后恢复可编辑，不跳结果页
        const reason = t && t.failureReason;
        showToast(reason === 'sensitive_rejected' ? '内容不符合要求' : '内容不符合站点要求', 'error');
        recoverAbort();
      },
      onError: (err) => {
        // Sprint 11 修复：任务不存在时绝不能继续停留"生成中"，需解锁并退出轮询
        if (err && err.code === API_ERROR.NOT_FOUND) {
          showToast('任务不存在或已过期，请重新生成', 'error');
          recoverAbort();
          return;
        }
        // 网络异常：退避重试，但设上限防永久卡住
        recoverErrorCount += 1;
        if (recoverErrorCount >= MAX_RECOVER_ERRORS) {
          showToast('连接异常，请刷新后重试', 'error');
          recoverAbort();
        } else {
          showToast('连接异常，正在重试…', 'error');
        }
      },
    });

    function recoverAbort() {
      if (watcher) { watcher.stop(); watcher = null; }
      busy = false;
      unlockAllTabs();
      hideStatus();
      clearTaskMeta();
      clearTaskRef();
      clearRetryMeta();
    }
  }

  function scheduleJump(taskId) {
    setTimeout(() => {
      location.href = `result.html?task=${taskId}`;
    }, JUMP_PAUSE_MS);
  }

  async function runSubmit({ prompt, refImage, mode, tagsPrompt, naturalPrompt }) {
    if (busy) return; // 防连点
    showStatus('生成中…');
    lockAllTabs();
    try {
      const task = await submit({ prompt, refImage, ipHash: getMockIpHash(), mode, tagsPrompt, naturalPrompt });
      activeTask = task;
      clearRetryMeta();
      clearTaskRef();
      startWatching({ id: task.id, taskToken: task.taskToken });
    } catch (err) {
      unlockAllTabs();
      hideStatus();
      if (err && (err.code === API_ERROR.SENSITIVE_REJECTED || err.code === 'SENSITIVE_REJECTED')) {
        showToast(err.message || '内容不符合要求', 'error');
      } else if (err && (err.code === API_ERROR.IP_BUSY || err.code === 'IP_BUSY')) {
        showToast(err.message || '当前已有任务进行中，请等待其结束后再提交', 'error');
      } else {
        showToast('提交失败，请稍后再试', 'error');
        console.error('[anima] submit error', err);
      }
    }
  }

  // ===== Tab 1: 自然语言生成 =====
  function initNatural() {
    const inputEl = document.getElementById('natural-input');
    const countEl = document.getElementById('natural-count');
    const errorEl = document.getElementById('prompt-error');
    const chipsEl = document.getElementById('example-chips');
    const refCheck = document.getElementById('natural-ref-check');
    const refUploaderEl = document.getElementById('natural-ref-uploader');
    const refPreviewEl = document.getElementById('natural-ref-preview');
    const refErrorEl = document.getElementById('natural-ref-error');
    const btnEl = document.getElementById('natural-btn');

    let refFileData = null;
    const promptInput = createPromptInput(inputEl, countEl, (msg) => {
      errorEl.textContent = msg || '';
      errorEl.style.color = msg ? 'var(--color-error)' : '';
    });

    createExampleChips(chipsEl, EXAMPLE_PROMPTS, (text) => {
      inputEl.value = text;
      promptInput.updateCount();
      inputEl.focus();
      inputEl.setSelectionRange(text.length, text.length);
    });

    const refUploader = createRefImageUploader(refUploaderEl, refPreviewEl, refErrorEl, (d) => { refFileData = d; });

    refCheck.addEventListener('change', () => {
      const on = refCheck.checked;
      refUploaderEl.hidden = !on;
      if (!on) { refUploader.remove(); refFileData = null; }
    });

    const genBtn = btnEl;
    genBtn.addEventListener('click', () => {
      const perr = promptInput.validate();
      if (perr) return;
      if (refErrorEl.textContent) return;
      runSubmit({ prompt: inputEl.value.trim(), refImage: refFileData, mode: 'natural' });
    });

    document.getElementById('natural-form').addEventListener('submit', (e) => e.preventDefault());

    return {
      restoreRef(dataUrl, mime) { refCheck.checked = true; refUploaderEl.hidden = false; refUploader.restoreFromDataUrl(dataUrl, mime); },
    };
  }

  // ===== Tab 2: 标签提示词 =====
  function initTags() {
    const tagsInputEl = document.getElementById('tags-input');
    const naturalInputEl = document.getElementById('tags-natural-input');
    const errorEl = document.getElementById('tags-error');
    const refCheck = document.getElementById('tags-ref-check');
    const refUploaderEl = document.getElementById('tags-ref-uploader');
    const refPreviewEl = document.getElementById('tags-ref-preview');
    const refErrorEl = document.getElementById('tags-ref-error');
    const btnEl = document.getElementById('tags-btn');

    let refFileData = null;
    const refUploader = createRefImageUploader(refUploaderEl, refPreviewEl, refErrorEl, (d) => { refFileData = d; });

    refCheck.addEventListener('change', () => {
      const on = refCheck.checked;
      refUploaderEl.hidden = !on;
      if (!on) { refUploader.remove(); refFileData = null; }
    });

    const genBtn = btnEl;
    genBtn.addEventListener('click', () => {
      const tags = tagsInputEl.value.trim();
      const natural = naturalInputEl.value.trim();
      if (!tags && !natural) {
        errorEl.textContent = '请输入标签提示词或自然语言提示词';
        errorEl.style.color = 'var(--color-error)';
        return;
      }
      errorEl.textContent = '';
      if (refErrorEl.textContent) return;
      runSubmit({ prompt: natural || tags, refImage: refFileData, mode: 'tags', tagsPrompt: tags, naturalPrompt: natural });
    });

    document.getElementById('tags-form').addEventListener('submit', (e) => e.preventDefault());

    return {
      restoreRef(dataUrl, mime) { refCheck.checked = true; refUploaderEl.hidden = false; refUploader.restoreFromDataUrl(dataUrl, mime); },
    };
  }

  // ===== Tab 3: 提取元数据 =====
  function initMetadata() {
    const uploaderEl = document.getElementById('meta-uploader');
    const errorEl = document.getElementById('meta-error');
    const resultEl = document.getElementById('meta-result');
    const bodyEl = document.getElementById('meta-body');
    const emptyEl = document.getElementById('meta-empty');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,.png';
    fileInput.hidden = true;
    uploaderEl.appendChild(fileInput);

    uploaderEl.addEventListener('click', () => { if (!uploaderEl.hasAttribute('aria-disabled')) fileInput.click(); });
    uploaderEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });

    async function handleFile(file) {
      if (!file) return;
      errorEl.textContent = '';
      resultEl.hidden = true;
      emptyEl.hidden = true;
      if (!/\.png$/i.test(file.name) && file.type !== 'image/png') {
        errorEl.textContent = '仅支持 PNG 格式';
        errorEl.style.color = 'var(--color-error)';
        return;
      }
      const buf = await file.arrayBuffer();
      const meta = parsePngMetadata(buf);
      const entries = Object.entries(meta);
      if (entries.length === 0) {
        emptyEl.hidden = false;
        return;
      }
      const lines = entries.map(([k, v]) => `${k}: ${v}`);
      bodyEl.textContent = lines.join('\n');
      resultEl.hidden = false;
    }
    fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
  }

  // ===== Tab 4: 4x 放大 =====
  function initUpscale() {
    const uploaderEl = document.getElementById('upscale-uploader');
    const errorEl = document.getElementById('upscale-error');
    const previewEl = document.getElementById('upscale-preview');
    const statusEl = document.getElementById('upscale-status');
    const btnEl = document.getElementById('upscale-btn');

    let upscaleFileData = null;
    // 复用参考图上传器（压缩后 dataUrl）
    const upUploader = createRefImageUploader(uploaderEl, previewEl, errorEl, (d) => {
      upscaleFileData = d;
      upscaleHasFile = !!d;
      btnEl.disabled = !d;
      if (!d) statusEl.textContent = '';
    });

    btnEl.addEventListener('click', () => {
      if (!upscaleFileData) return;
      statusEl.textContent = '放大中…';
      statusEl.style.color = '';
      runSubmit({ prompt: 'upscale', refImage: upscaleFileData, mode: 'upscale' });
    });
  }

  const naturalApi = initNatural();
  const tagsApi = initTags();
  initMetadata();
  initUpscale();

  // ===== 刷新恢复（简化：同会话有进行中任务 → 继续轮询，仅终态跳转） =====
  function tryRestore() {
    const meta = getTaskMeta();
    if (!meta || !meta.taskId || !meta.taskToken) return;
    activeTask = { id: meta.taskId, taskToken: meta.taskToken };
    lockAllTabs();
    showStatus('继续生成中…');
    startWatching(activeTask);
  }

  // ===== 失败重试回填（结果页"重试"→ 回主页预填） =====
  function tryRetry() {
    const retry = getRetryMeta();
    if (!retry || !retry.prompt) return;
    if (retry.mode === 'tags') {
      switchTab('tags');
      const ti = document.getElementById('tags-input');
      if (retry.tagsPrompt) ti.value = retry.tagsPrompt;
      const ni = document.getElementById('tags-natural-input');
      if (retry.naturalPrompt) ni.value = retry.naturalPrompt;
      if (retry.refDataUrl) tagsApi.restoreRef(retry.refDataUrl, retry.refMime || 'image/jpeg');
    } else {
      switchTab('natural');
      const ni = document.getElementById('natural-input');
      ni.value = retry.prompt;
      naturalApi.restoreRef && retry.refDataUrl && naturalApi.restoreRef(retry.refDataUrl, retry.refMime || 'image/jpeg');
    }
  }

  tryRestore();
  tryRetry();

  // ===== 合规元素（Cookie 同意条 + Push 关闭） =====
  initCompliance();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHome);
} else {
  initHome();
}