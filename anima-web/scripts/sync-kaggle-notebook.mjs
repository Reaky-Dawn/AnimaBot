#!/usr/bin/env node
/**
 * scripts/sync-kaggle-notebook.mjs —— 把 kaggle-notebook/animabot-worker.ipynb
 * 内联为 src/kaggle-notebook-inline.js（Sprint 15：Worker 直推 kernels/push 的 text 源）。
 *
 * 用法：node scripts/sync-kaggle-notebook.mjs
 * 在 notebook 变更后、wrangler deploy 前运行（deploy.ps1 已自动调用）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nbPath = join(root, '..', 'kaggle-notebook', 'animabot-worker.ipynb');
const outPath = join(root, 'src', 'kaggle-notebook-inline.js');

const nb = JSON.parse(readFileSync(nbPath, 'utf8'));
// 与 kaggle CLI 推送行为一致：清空 code cell outputs、source 数组合并为单字符串
for (const cell of nb.cells) {
  if (cell.cell_type === 'code' && 'outputs' in cell) cell.outputs = [];
  if (Array.isArray(cell.source)) cell.source = cell.source.join('');
}
const text = JSON.stringify(nb);

const content = `/**
 * kaggle-notebook-inline.js —— 引擎 notebook 的 JS 模块内联（Sprint 15，构建产物）。
 *
 * ⚠️ 本文件由 scripts/sync-kaggle-notebook.mjs 从 kaggle-notebook/animabot-worker.ipynb
 * 生成，请勿手改；源 notebook 变更后运行：node scripts/sync-kaggle-notebook.mjs
 */

const KAGGLE_NOTEBOOK_TEXT = ${JSON.stringify(text)};

export default KAGGLE_NOTEBOOK_TEXT;
`;
writeFileSync(outPath, content);
console.log(`[sync] ${nbPath} -> ${outPath} (${text.length} chars)`);
