// 公共工具函数
/**
 * 格式化日期为 YYYY-MM-DD HH:mm
 * @param {Date} date
 * @returns {string}
 */
export function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * 防抖：延迟执行，连续触发时重置计时
 * @param {Function} fn
 * @param {number} wait 毫秒
 * @returns {Function}
 */
export function debounce(fn, wait = 300) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}
