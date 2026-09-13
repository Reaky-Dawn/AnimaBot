/**
 * runtime/shared.js —— 两页共享的合规/通用辅助（Sprint 6 → Sprint 16）
 *
 * 依据：docs/interface-design.md 3.4（Cookie 同意条）、NFR-14；Sprint 16 每日流量统计
 * 依赖：repo（storage：cookie 标记、device token）、ui（组件）
 * 层级：runtime（胶水层，供 home.js / result.js 复用）
 */

import { getCookieConsent, setCookieConsent, getDeviceToken } from '../repo/storage.js';
import { createCookieConsentBar } from '../ui/components.js';

/**
 * 合规元素初始化（两页调用一次）：
 *  - Cookie 同意条：首次访问（无 localStorage 标记）显示，点"知道了"记录标记（NFR-14）
 *  - Sprint 16：广告全部移除，无第三方脚本；本条不再含广告初始化
 */
export function initCompliance() {
  const cookieBarEl = document.querySelector('.cookie-bar');
  if (cookieBarEl) {
    const bar = createCookieConsentBar(cookieBarEl, () => setCookieConsent());
    if (!getCookieConsent()) bar.show();
  }
  reportVisit();
}

/**
 * 每日流量上报（Sprint 16）：页面载入后 fire-and-forget 上报一次 PV。
 * 隐私：不收集 IP/UA/指纹；服务端只记「日期 + 数字」。
 * uv 去重：浏览器 localStorage 里的随机 device token（本机自生成，非设备指纹），
 * 同日同 token 只计 1 次访客（由服务端去重）。
 * 同日重复刷新：PV 照记（页面浏览量语义），上报频率 30s 内去抖防连点。
 */
let _visitReported = false;
export function reportVisit() {
  if (_visitReported) return;
  _visitReported = true;
  try {
    const token = getDeviceToken();
    fetch('/api/stats/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ d: token, p: location.pathname.startsWith('/result') ? 'result' : 'index' }),
      keepalive: true,
    }).catch(() => {}); // 统计失败静默，绝不影响主流程
  } catch (e) { /* 存储不可用（隐私模式）：放弃统计 */ }
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
