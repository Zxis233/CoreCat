/**
 * Main - 应用入口
 * 初始化应用
 */

import { initApp } from './events.js';
import { COMMIT_HASH } from './version.js';

function renderCommitHash() {
  const el = document.getElementById("commit-hash");
  if (!el || !COMMIT_HASH) {
    return;
  }
  el.textContent = COMMIT_HASH;
  el.title = `Commit ${COMMIT_HASH}`;
}

// 启动应用
renderCommitHash();
initApp();
