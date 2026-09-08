/**
 * repo/gallery-store.js —— 最近作品本地画廊（IndexedDB）
 *
 * 背景：结果页「即用即删」（展示就绪即 confirmDelivered 删服务端任务+图），
 *       用户关页后无法找回已完成图片 → 在本机 IndexedDB 留底。
 * 保留策略：savedAt 起 1 小时，读取时惰性清理过期项（不占服务端，无隐私出域）。
 * 层级：repo（数据访问）
 */

const DB_NAME = 'anima-gallery';
const DB_VERSION = 1;
const STORE = 'items';
/** 保留时长（毫秒）：1 小时 */
export const GALLERY_TTL_MS = 60 * 60 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 成功出图后落库（blob 仅存本机）。重复完成同一任务时覆盖。 */
export async function saveToGallery({ id, blob, prompt, mode, savedAt }) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ id, blob, prompt: prompt || '', mode: mode || '', savedAt: savedAt || Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    // 画廊是锦上添花，任何失败不影响主流程
    console.warn('[anima] gallery save failed', e);
  }
}

/** 列出未过期作品（新→旧），并惰性清理过期项。 */
export async function listGallery() {
  try {
    const db = await openDb();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const now = Date.now();
    const fresh = [];
    const expiredIds = [];
    for (const item of all) {
      if (item.savedAt && now - item.savedAt < GALLERY_TTL_MS) fresh.push(item);
      else expiredIds.push(item.id);
    }
    if (expiredIds.length) {
      await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const id of expiredIds) store.delete(id);
        tx.oncomplete = resolve;
        tx.onerror = resolve; // 清理失败不阻塞
      });
    }
    db.close();
    fresh.sort((a, b) => b.savedAt - a.savedAt);
    return fresh;
  } catch (e) {
    console.warn('[anima] gallery list failed', e);
    return [];
  }
}

/** 手动清空全部历史。 */
export async function clearGallery() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('[anima] gallery clear failed', e);
  }
}
