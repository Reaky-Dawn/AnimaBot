/**
 * ui/components.js —— DOM 组件（纯渲染与交互，不含业务逻辑）
 *
 * 依据：docs/interface-design.md 2.1.2/2.1.3（主页组件树）、docs/tech-design.md v2.0 第 2 节
 * 依赖：types（仅常量），不引用 service/repo/config
 * 层级：ui（最上层，只做 DOM 渲染，业务通过回调交给 runtime）
 *
 * 约定：组件只接收渲染数据与回调；错误文案用 textContent 渲染（NFR-06，不拼 HTML）。
 */

import { INPUT_LIMITS, TASK_STATUS, NODE_MAP, FAILURE_REASON } from '../types/task.js';

/**
 * PromptInput —— 描述输入组件
 * 职责：计数（超 500 变 --color-error）、错误描边与错误文案、焦点/禁用态
 * 参数：root（textarea 元素）、countEl（计数元素）、onError（回调，校验错误时通知）
 */
export function createPromptInput(root, countEl, onError) {
  let currentError = null;

  const updateCount = () => {
    const len = root.value.length;
    const over = len > INPUT_LIMITS.PROMPT_MAX_CHARS;
    countEl.textContent = `${len} / ${INPUT_LIMITS.PROMPT_MAX_CHARS}`;
    countEl.style.color = over ? 'var(--color-error)' : '';
    // 超长时实时提示（AC-P0-06）
    if (over) {
      setError('描述过长');
    } else if (currentError === '描述过长') {
      clearError();
    }
  };

  const setError = (msg) => {
    currentError = msg;
    root.style.borderColor = 'var(--color-error)';
    if (onError) onError(msg);
  };

  const clearError = () => {
    currentError = null;
    root.style.borderColor = '';
    if (onError) onError(null);
  };

  /** 校验（空/超长）。返回错误文案或 null */
  const validate = () => {
    const len = root.value.trim().length;
    if (len === 0) {
      setError('请输入描述'); // AC-P0-05
      return '请输入描述';
    }
    if (len > INPUT_LIMITS.PROMPT_MAX_CHARS) {
      setError('描述过长'); // AC-P0-06
      return '描述过长';
    }
    clearError();
    return null;
  };

  const reset = () => {
    root.value = '';
    updateCount();
    clearError();
  };

  root.addEventListener('input', updateCount);

  return { root, validate, reset, updateCount, setError, clearError };
}

/**
 * ExampleChips —— 示例提示词胶囊
 * 职责：点击将示例文案填入输入框（替换现有内容 + 聚焦 + 光标置尾）
 * 参数：container（chips 容器）、examples（string[]）、onPick（回调，点击时通知）
 */
export function createExampleChips(container, examples, onPick) {
  const buttons = examples.map((text) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = text;
    btn.setAttribute('aria-label', `示例：${text}`);
    btn.addEventListener('click', () => {
      if (onPick) onPick(text);
    });
    container.appendChild(btn);
    return btn;
  });

  const setDisabled = (disabled) => {
    buttons.forEach((b) => { b.disabled = disabled; });
  };

  return { setDisabled };
}

/**
 * RefImageUploader —— 参考图上传组件
 * 职责：文件选择/拖拽、格式与大小校验（AC-P0-09）、Canvas 压缩（NFR-04）、
 *       缩略预览、移除、错误文案、禁用态
 * 参数：container（上传区根元素）、previewEl（缩略预览容器）、errorEl（错误文案元素）
 *       onFileChange（回调：压缩后得到 {file, dataUrl, width, height} 或 null）
 */
export function createRefImageUploader(container, previewEl, errorEl, onFileChange) {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  container.appendChild(fileInput);

  let currentDataUrl = null;
  let currentFile = null;
  let currentError = null;

  // ===== 校验 =====
  const validateFile = (file) => {
    const isAllowedType = INPUT_LIMITS.REF_IMAGE_ALLOWED_TYPES.includes(file.type);
    const isAllowedExt = INPUT_LIMITS.REF_IMAGE_ALLOWED_EXTENSIONS.some(
      (ext) => file.name.toLowerCase().endsWith(ext)
    );
    if (!isAllowedType && !isAllowedExt) {
      setError('仅支持常见图片格式'); // AC-P0-09
      return false;
    }
    if (file.size > INPUT_LIMITS.REF_IMAGE_MAX_SIZE_BYTES) {
      setError('图片过大，请压缩后上传'); // AC-P0-09
      return false;
    }
    clearError();
    return true;
  };

  const setError = (msg) => {
    currentError = msg;
    container.style.borderColor = 'var(--color-error)';
    errorEl.textContent = msg;
    errorEl.style.color = 'var(--color-error)';
  };

  const clearError = () => {
    currentError = null;
    container.style.borderColor = '';
    errorEl.textContent = '';
    errorEl.style.color = '';
  };

  // ===== Canvas 压缩（NFR-04：≤1024px、JPEG q0.8；PNG 透明保留 PNG） =====
  const compressImage = (file) =>
    new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        const maxW = INPUT_LIMITS.REF_IMAGE_COMPRESS_MAX_WIDTH;
        if (width > maxW) {
          height = Math.round((height * maxW) / width);
          width = maxW;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        // 保留透明：PNG 用 PNG，其余转 JPEG
        const keepAlpha = file.type === 'image/png';
        if (!keepAlpha) {
          // 深色页面上透明区填充背景色，避免 JPEG 黑底
          ctx.fillStyle = '#171b34';
          ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(img, 0, 0, width, height);
        const mime = keepAlpha ? 'image/png' : 'image/jpeg';
        const dataUrl = canvas.toDataURL(mime, keepAlpha ? undefined : INPUT_LIMITS.REF_IMAGE_COMPRESS_QUALITY);
        resolve({ dataUrl, width, height, mime });
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });

  // ===== 选择文件 =====
  const pickFile = async (file) => {
    if (!file) return;
    if (!validateFile(file)) return;
    const compressed = await compressImage(file);
    if (!compressed) {
      setError('图片处理失败，请重试');
      return;
    }
    currentFile = file;
    currentDataUrl = compressed.dataUrl;
    // 缩略预览
    previewEl.innerHTML = '';
    const thumb = document.createElement('img');
    thumb.src = compressed.dataUrl;
    thumb.alt = '参考图预览';
    thumb.className = 'uploader__thumb';
    const name = document.createElement('span');
    name.className = 'uploader__filename';
    name.textContent = file.name;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn--secondary uploader__remove';
    removeBtn.textContent = '移除';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      remove();
    });
    previewEl.appendChild(thumb);
    previewEl.appendChild(name);
    previewEl.appendChild(removeBtn);
    container.setAttribute('data-has-file', 'true');
    // 反馈（AC-P0-07）
    announce('已添加参考图');
    if (onFileChange) onFileChange({ file, dataUrl: compressed.dataUrl, width: compressed.width, height: compressed.height, mime: compressed.mime });
  };

  const remove = () => {
    currentFile = null;
    currentDataUrl = null;
    previewEl.innerHTML = '';
    container.removeAttribute('data-has-file');
    fileInput.value = '';
    clearError();
    announce('已移除参考图');
    if (onFileChange) onFileChange(null);
  };

  const announce = (msg) => {
    // aria-live 播报（AC-P0-07/08）
    const live = document.createElement('div');
    live.setAttribute('role', 'status');
    live.className = 'visually-hidden';
    live.textContent = msg;
    document.body.appendChild(live);
    setTimeout(() => live.remove(), 500);
  };

  // ===== 事件绑定 =====
  container.addEventListener('click', () => { if (!container.hasAttribute('aria-disabled')) fileInput.click(); });
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => pickFile(fileInput.files[0]));
  // 拖拽（桌面/平板；移动端无拖拽，走点击）
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.style.borderColor = 'var(--color-primary)';
  });
  container.addEventListener('dragleave', () => {
    container.style.borderColor = '';
  });
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.style.borderColor = '';
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) pickFile(file);
  });

  const setDisabled = (disabled) => {
    if (disabled) {
      container.setAttribute('aria-disabled', 'true');
      container.removeAttribute('role');
      container.removeAttribute('tabindex');
    } else {
      container.removeAttribute('aria-disabled');
      container.setAttribute('role', 'button');
      container.setAttribute('tabindex', '0');
    }
  };

  /** 重试回填：从 dataUrl 恢复预览与内部状态（AC-P0-18，同会话参考图） */
  const restoreFromDataUrl = (dataUrl, mime, filename = '参考图（重试）') => {
    const img = new Image();
    img.onload = () => {
      currentFile = null;
      currentDataUrl = dataUrl;
      previewEl.innerHTML = '';
      const thumb = document.createElement('img');
      thumb.src = dataUrl;
      thumb.alt = '参考图预览';
      thumb.className = 'uploader__thumb';
      const name = document.createElement('span');
      name.className = 'uploader__filename';
      name.textContent = filename;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn--secondary uploader__remove';
      removeBtn.textContent = '移除';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        remove();
      });
      previewEl.appendChild(thumb);
      previewEl.appendChild(name);
      previewEl.appendChild(removeBtn);
      container.setAttribute('data-has-file', 'true');
      clearError();
      if (onFileChange) {
        onFileChange({ file: null, dataUrl, width: img.width, height: img.height, mime });
      }
    };
    img.src = dataUrl;
  };

  return {
    pickFile, remove, setDisabled, restoreFromDataUrl,
    get hasFile() { return currentFile !== null || currentDataUrl !== null; },
    get dataUrl() { return currentDataUrl; },
  };
}

/**
 * GenerateButton —— 生成按钮
 * 职责：点击触发校验回调；提交瞬间禁用防连点；禁用态
 */
export function createGenerateButton(btn, onSubmit) {
  let locked = false;

  const setDisabled = (disabled) => {
    btn.disabled = disabled;
    if (disabled) btn.classList.add('btn--disabled');
    else btn.classList.remove('btn--disabled');
  };

  btn.addEventListener('click', () => {
    if (locked || btn.disabled) return;
    if (onSubmit) onSubmit();
  });

  // 提交瞬间禁用（防连点）
  const lock = () => { locked = true; setDisabled(true); };
  const unlock = () => { locked = false; setDisabled(false); };

  return { setDisabled, lock, unlock };
}

/**
 * TaskStatusPanel —— 5 节点进度条组件（Sprint 4）
 * 职责：渲染 排队中 → 提示词构思中 → 提示词完成 → 绘制中 → 完成/失败 五节点；
 *       节点只前进不回退（AC-P0-02）；节点 1 排队"前方等待 N 人"（F07）；
 *       完成绿勾 / 当前星蓝 glow / 待办轨道；aria-live 播报进度变化。
 * 参数：root（ol.progress 元素）
 * 依据：docs/interface-design.md 2.1.3（节点进度条）、design-tokens.css（--progress-* 令牌）
 * 层级：ui（仅引用 types 常量，业务通过 update() 数据驱动）
 */
export function createTaskStatusPanel(root) {
  // NODE_MAP 中 FAILED 与 DONE 同 stage 5，去重后为 5 个节点
  const nodes = [];
  NODE_MAP.forEach((n) => { if (!nodes.some((x) => x.stage === n.stage)) nodes.push(n); });

  let maxStage = 1;
  let lastStage = 0;

  // ===== 渲染 =====
  function build() {
    root.innerHTML = '';
    nodes.forEach((n) => {
      const li = document.createElement('li');
      li.className = 'progress__item';
      li.dataset.stage = String(n.stage);

      const dot = document.createElement('span');
      dot.className = 'progress__dot';
      dot.setAttribute('aria-hidden', 'true');
      dot.textContent = String(n.stage);

      const text = document.createElement('span');
      text.className = 'progress__text';
      const label = document.createElement('span');
      label.className = 'progress__label';
      label.textContent = n.label;
      const hint = document.createElement('span');
      hint.className = 'progress__hint';
      hint.dataset.hint = '';
      text.appendChild(label);
      text.appendChild(hint);

      li.appendChild(dot);
      li.appendChild(text);
      root.appendChild(li);
    });
  }

  // ===== 状态更新（只前进） =====
  /**
   * @param {Object} s
   * @param {number} s.stage    当前最大节点（1-5）
   * @param {number} [s.queuePos] 排队位置（节点 1 显示"前方等待 N 人"）
   * @param {string} s.status   TASK_STATUS 值
   */
  function update(s) {
    let { stage, queuePos = 0, status } = s;
    // 防御：stage 回退时忽略（节点只前进，AC-P0-02）
    if (stage < maxStage) stage = maxStage;
    else maxStage = stage;

    const doneTerminal = status === TASK_STATUS.DONE && stage === 5;
    const failedTerminal = status === TASK_STATUS.FAILED && stage === 5;
    const terminal = doneTerminal || failedTerminal;

    const stageChanged = stage !== lastStage;
    lastStage = stage;

    root.querySelectorAll('.progress__item').forEach((li) => {
      const s2 = Number(li.dataset.stage);
      const isDoneNode = s2 < stage;
      const isLastNode = s2 === 5;

      li.classList.toggle('is-done', isDoneNode || doneTerminal);
      li.classList.toggle('is-current', s2 === stage && !terminal);
      li.classList.toggle('is-failed', failedTerminal && isLastNode);
      li.classList.toggle('is-pending', s2 > stage);

      const dot = li.querySelector('.progress__dot');
      dot.textContent = (isDoneNode || doneTerminal) ? '✓' : (failedTerminal && isLastNode) ? '✕' : String(s2);

      // 失败终态：节点 5 步骤名换"失败"
      const label = li.querySelector('.progress__label');
      if (failedTerminal && isLastNode) label.textContent = '失败';

      // 动态小字
      const hint = li.querySelector('.progress__hint');
      if (s2 === 1 && stage === 1 && status === TASK_STATUS.QUEUED) {
        // 队列为空（queuePos=0）不显示等待人数（AC-P0-13 后半）
        hint.textContent = queuePos > 0 ? `前方等待 ${queuePos} 人` : '';
      } else if (s2 === 4 && stage === 4 && status === TASK_STATUS.DRAWING) {
        hint.textContent = '正在绘制，稍等片刻～';
      } else {
        hint.textContent = '';
      }
    });

    // aria-live 播报（仅节点前进时；终态单列）
    if (stageChanged) {
      if (doneTerminal) {
        announce('任务已完成');
      } else if (failedTerminal) {
        announce('任务失败');
      } else {
        const n = nodes.find((x) => x.stage === stage);
        if (n) announce(`任务进入「${n.label}」`);
      }
    }

    return { stage: maxStage };
  }

  /** 播报（role=status 的 visually-hidden 节点，NFR-21 无障碍） */
  function announce(msg) {
    const live = document.createElement('div');
    live.setAttribute('role', 'status');
    live.className = 'visually-hidden';
    live.textContent = msg;
    document.body.appendChild(live);
    setTimeout(() => live.remove(), 800);
  }

  function reset() {
    maxStage = 1;
    lastStage = 0;
    build();
  }

  build();
  return { root, update, announce, reset };
}

// ===== 结果页组件（Sprint 5） =====
// 注意：ui 层不引用 service/repo，仅渲染 + 回调通知 runtime。

// ---- 失败原因文案映射（NFR-19/20 + 萌系口径） ----
export const FAILURE_COPY = {
  [FAILURE_REASON.PROMPT_FAILED]: '提示词构思失败，请重试',
  [FAILURE_REASON.DRAW_FAILED]: '绘制失败，请重试',
  [FAILURE_REASON.TIMEOUT]: '生成超时，请重试',
  [FAILURE_REASON.ENGINE_UNAVAILABLE]: '引擎维护中，请稍后再试',
  [FAILURE_REASON.NSFW_REJECTED]: '内容不符合站点要求',
  [FAILURE_REASON.SENSITIVE_REJECTED]: '内容不符合要求',
};
export function failureReasonText(reason) {
  return FAILURE_COPY[reason] || '生成失败，请重试';
}

/**
 * ResultGallery —— 结果画廊区
 * 参数：root（.gallery 容器）
 * 返回：{ showLoading, showImage({src, alt}), onOpenClick(cb) }
 */
export function createResultGallery(root) {
  const img = root.querySelector('.gallery__img');
  const placeholder = root.querySelector('#gallery-placeholder');
  const frame = root.querySelector('.gallery__frame');
  let openCb = null;

  function showLoading() {
    img.hidden = true;
    if (placeholder) placeholder.hidden = false;
  }

  function showImage({ src, alt }) {
    img.alt = alt || 'AI 生成图片';
    // 渐进呈现（NFR-02）：占位保留到图片真正加载完成
    img.onload = () => {
      img.hidden = false;
      if (placeholder) placeholder.hidden = true;
    };
    img.onerror = () => {
      img.hidden = true;
      if (placeholder) placeholder.hidden = false;
    };
    img.src = src;
    // 点击图片 → 打开灯箱
    img.onclick = () => { if (openCb) openCb(src, alt); };
  }

  function onOpenClick(cb) { openCb = cb; }

  showLoading();
  return { showLoading, showImage, onOpenClick };
}

/**
 * ActionBar —— 操作区（结果页）
 * 参数：root（.actions 容器）
 * 按钮：下载 PNG / 下载 JPEG（主）、放大 4x（M2 占位禁用）、再生成一张（返回区）
 * 返回：{ setEnabled(main, regen), onDownloadPng, onDownloadJpeg, onRegenerate, onUpscale, setUpscaleLoading }
 */
export function createActionBar(root) {
  const btnPng = root.querySelector('.actions__primary .btn--primary:first-child');
  const btnJpeg = root.querySelector('.actions__primary .btn--primary:last-child');
  const btnUpscale = root.querySelector('.actions__secondary .btn--secondary');
  const btnRegen = root.querySelector('.actions__return .btn');

  function setEnabled(main, regen) {
    [btnPng, btnJpeg].forEach((b) => { if (b) b.disabled = !main; });
    if (btnRegen) btnRegen.disabled = !regen;
  }

  const onDownloadPng = (cb) => { if (btnPng) btnPng.addEventListener('click', cb); };
  const onDownloadJpeg = (cb) => { if (btnJpeg) btnJpeg.addEventListener('click', cb); };
  const onRegenerate = (cb) => { if (btnRegen) btnRegen.addEventListener('click', cb); };
  const onUpscale = (cb) => { if (btnUpscale) btnUpscale.addEventListener('click', cb); };
  const setUpscaleLoading = (loading) => {
    if (btnUpscale) btnUpscale.textContent = loading ? '放大中…' : '放大 4x';
  };

  setEnabled(false, false);
  return { setEnabled, onDownloadPng, onDownloadJpeg, onRegenerate, onUpscale, setUpscaleLoading };
}

/**
 * Lightbox —— 放大灯箱
 * 参数：root（#lightbox 容器）
 * 返回：{ open(src, alt), close }
 */
export function createLightbox(root) {
  const img = root.querySelector('.lightbox__img');
  const closeBtn = root.querySelector('.lightbox__close');
  let triggerEl = null; // 焦点归还目标
  let prevBodyOverflow = '';

  function open(src, alt) {
    triggerEl = document.activeElement;
    prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    img.src = src;
    img.alt = alt || 'AI 生成图片（放大）';
    root.hidden = false;
    // 聚焦关闭按钮
    setTimeout(() => closeBtn.focus(), 100);
  }

  function close() {
    root.hidden = true;
    document.body.style.overflow = prevBodyOverflow;
    img.src = '';
    if (triggerEl && triggerEl.focus) triggerEl.focus();
  }

  // 关闭按钮
  closeBtn.addEventListener('click', close);

  // Esc（document 级：焦点尚未移入灯箱时也可关闭）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) close();
  });

  // 点遮罩关闭（非图片区域）
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });

  return { open, close };
}

/**
 * InvalidTaskCard —— 任务无效态
 * 参数：root（#invalid-card 容器）
 * 返回：{ show() }
 */
export function createInvalidCard(root) {
  function show() {
    root.hidden = false;
    const btn = root.querySelector('.btn');
    if (btn) setTimeout(() => btn.focus(), 100);
  }
  return { show };
}

/**
 * FailCard —— 失败态卡（Sprint 10：支持完整日志折叠区）
 * 参数：root
 * 返回：{ show(reasonText, engineLog?), hide() }
 */
export function createFailCard(root) {
  const icon = root.querySelector('.fail-card__icon');
  const text = root.querySelector('.fail-card__text');
  const logWrap = root.querySelector('.fail-card__log');
  const logToggle = root.querySelector('.fail-card__log-toggle');
  const logBody = root.querySelector('.fail-card__log-body');

  // 折叠切换（首次展开填充内容）
  if (logToggle && logBody) {
    logToggle.addEventListener('click', () => {
      const expanded = logToggle.getAttribute('aria-expanded') === 'true';
      logToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      logToggle.textContent = expanded ? '查看完整日志 ▾' : '收起完整日志 ▴';
      logBody.hidden = expanded;
    });
  }

  // 把 engine_log（JSON 数组）渲染为可读时间线文本
  function formatLog(engineLog) {
    if (!engineLog) return '';
    let arr = engineLog;
    if (typeof engineLog === 'string') {
      try { arr = JSON.parse(engineLog); } catch (e) { return engineLog; }
    }
    if (!Array.isArray(arr)) return String(engineLog);
    const nameMap = {
      claim: '任务接管',
      ref_downloaded: '参考图获取',
      ref_download_failed: '参考图获取失败',
      params_parsed: '参数解析',
      prompt_generated: '提示词生成',
      nsfw_checked: 'NSFW 检查',
      nsfw_rejected: 'NSFW 拦截',
      prompt_done: '提示词完成',
      drawing_start: '绘制开始',
      drawing_done: '绘制完成',
      postprocess_done: '后处理（压缩/元数据）',
      result_uploaded: '结果上传',
      done: '完成',
      failed: '失败',
    };
    return arr
      .map((s) => {
        const t = new Date(s.ts || 0);
        const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
        const label = nameMap[s.action] || s.action;
        const elapsed = s.elapsed != null ? `（+${s.elapsed}s）` : '';
        return `▸ ${clock}${elapsed} ${label}${s.detail ? '\n   ' + s.detail : ''}`;
      })
      .join('\n');
  }

  function show(reason, engineLog) {
    root.hidden = false;
    if (text) text.textContent = reason;
    // 有完整日志才展示折叠入口
    if (logWrap && logBody) {
      const bodyText = formatLog(engineLog);
      if (bodyText) {
        logWrap.hidden = false;
        logBody.textContent = bodyText;
        logToggle.setAttribute('aria-expanded', 'false');
        logToggle.textContent = '查看完整日志 ▾';
        logBody.hidden = true;
      } else {
        logWrap.hidden = true;
      }
    }
  }
  function hide() { root.hidden = true; }
  return { show, hide };
}

/**
 * 图片格式转换：Blob(PNG) → Blob(JPEG) 用于下载。
 * 需要 DOM Canvas（ui 层在浏览器环境，合规）。
 */
export function blobToJpeg(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('JPEG 转换失败'));
      }, 'image/jpeg', 0.92);
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = URL.createObjectURL(blob);
  });
}

/**
 * CookieConsentBar —— Cookie 同意条（Sprint 6，NFR-14）
 * 职责：显示/隐藏同意条；点击"知道了"通知 runtime（由 runtime 负责 localStorage 标记）。
 * 参数：root（.cookie-bar 容器）、onConsent（回调，点"知道了"时调用）
 * 返回：{ show(), hide() }
 */
export function createCookieConsentBar(root, onConsent) {
  const btn = root.querySelector('.cookie-bar__btn');
  if (btn) {
    btn.addEventListener('click', () => {
      if (onConsent) onConsent();
      hide();
    });
  }
  function show() { root.hidden = false; }
  function hide() { root.hidden = true; }
  return { show, hide };
}

/**
 * initPushAdClose —— In-Page Push 广告占位关闭按钮（占位期关闭即隐藏容器）
 * 参数：scope（默认 document，供两页初始化）
 */
export function initPushAdClose(scope = document) {
  scope.querySelectorAll('.ad-slot__close').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = btn.closest('.ad-slot');
      if (slot) slot.hidden = true;
    });
  });
}

/**
 * AdminNoteDialog —— 站务说明浮层（Sprint 7，AC-P0-22 / D5）
 * 职责：顶部栏 ⓘ 打开 → 展示"NSFW 拦截为服务端配置、默认开启、页面不设开关"；
 *       关闭按钮 / Esc / 点遮罩关闭；焦点移入关闭按钮、关闭后归还触发元素。
 * 参数：root（.admin-note 容器）
 * 返回：{ open(), close() }
 */
export function createAdminNoteDialog(root) {
  const closeBtn = root.querySelector('.admin-note__close');
  let lastFocus = null;

  function open() {
    lastFocus = document.activeElement;
    root.hidden = false;
    if (closeBtn) setTimeout(() => closeBtn.focus(), 100);
  }
  function close() {
    root.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  if (closeBtn) closeBtn.addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) close();
  });

  return { open, close };
}
