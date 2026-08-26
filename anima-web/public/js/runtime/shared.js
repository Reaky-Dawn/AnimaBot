/**
 * runtime/shared.js —— 两页共享的合规/通用辅助（Sprint 6）
 *
 * 依据：docs/interface-design.md 3.2/3.4（Push 关闭、Cookie 同意条）、NFR-12/14
 * 依赖：repo（storage：cookie 标记）、ui（组件）
 * 层级：runtime（胶水层，供 home.js / result.js 复用）
 */

import { getCookieConsent, setCookieConsent } from '../repo/storage.js';
import { createCookieConsentBar, initPushAdClose } from '../ui/components.js';

/**
 * 合规元素初始化（两页调用一次）：
 *  - Cookie 同意条：首次访问（无 localStorage 标记）显示，点"知道了"记录标记（NFR-14）
 *  - In-Page Push 占位关闭按钮：占位期点击关闭即隐藏（interface-design 3.2）
 */
export function initCompliance() {
  const cookieBarEl = document.querySelector('.cookie-bar');
  if (cookieBarEl) {
    const bar = createCookieConsentBar(cookieBarEl, () => setCookieConsent());
    if (!getCookieConsent()) bar.show();
  }
  initPushAdClose();
}

/**
 * 统一 Toast（两页共用；左条 + 图标，--z-toast）。
 */
export function showToast(message, type = 'error') {
  const existing = document.querySelector('.toast-anima');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast-anima toast-anima--' + type;
  toast.setAttribute('role', 'alert');
  const icon = document.createElement('span');
  icon.className = 'toast-anima__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = type === 'success' ? '✓' : '!';
  toast.appendChild(icon);
  toast.appendChild(document.createTextNode(message));
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
