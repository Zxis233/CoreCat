/**
 * History - undo/redo snapshots
 * Keeps the last configured changes plus the current state.
 */

import { HISTORY_MAX_BYTES, HISTORY_MAX_STEPS } from './constants.js';
import { state } from './state.js';
import { serializeState, loadState } from './export.js';

const MAX_HISTORY = Math.max(
  1,
  Math.round(Number.isFinite(HISTORY_MAX_STEPS) ? HISTORY_MAX_STEPS : 0) + 1
);
const MAX_HISTORY_BYTES = Math.max(
  1024 * 1024,
  Number.isFinite(HISTORY_MAX_BYTES) ? HISTORY_MAX_BYTES : 0
);
const COALESCED_HISTORY_DELAY = 600;
let undoStack = [];
let redoStack = [];
let isRestoring = false;
let coalescedHistoryTimer = null;
let isCoalescingHistory = false;

function stopCoalescingHistory() {
  if (coalescedHistoryTimer) {
    clearTimeout(coalescedHistoryTimer);
    coalescedHistoryTimer = null;
  }
  isCoalescingHistory = false;
}

function isValidSelection(selection) {
  if (!selection || typeof selection !== 'object') {
    return false;
  }
  if (selection.type === 'module') {
    return state.modules.some((mod) => mod.id === selection.id);
  }
  if (selection.type === 'wire') {
    return state.wires.some((wire) => wire.id === selection.id);
  }
  return false;
}

function makeSnapshot() {
  // serializeState is the codec boundary and returns a detached object graph.
  // Avoid cloning it a second time on every property input/history record.
  const data = serializeState();
  const typeCounts = { ...state.typeCounts };
  const signature = JSON.stringify({ data, typeCounts });
  return {
    data,
    typeCounts,
    selection: state.selection ? { ...state.selection } : null,
    signature,
    // Approximate UTF-16 signature + detached object graph overhead.
    estimatedBytes: signature.length * 4,
  };
}

function trimHistoryStack(stack, minimumEntries = 1) {
  let estimatedBytes = stack.reduce(
    (total, snapshot) => total + (snapshot.estimatedBytes || snapshot.signature.length * 4),
    0
  );
  while (
    stack.length > minimumEntries &&
    (stack.length > MAX_HISTORY || estimatedBytes > MAX_HISTORY_BYTES)
  ) {
    const removed = stack.shift();
    estimatedBytes -= removed.estimatedBytes || removed.signature.length * 4;
  }
}

function pushSnapshot(snapshot) {
  if (undoStack.length === 0) {
    undoStack = [snapshot];
    redoStack = [];
    return;
  }
  const last = undoStack[undoStack.length - 1];
  if (last && last.signature === snapshot.signature) {
    return;
  }
  undoStack.push(snapshot);
  trimHistoryStack(undoStack, 2);
  redoStack = [];
}

function replaceCoalescedSnapshot(snapshot) {
  const previous = undoStack[undoStack.length - 2];
  if (previous && previous.signature === snapshot.signature) {
    undoStack.pop();
    isCoalescingHistory = false;
    return;
  }
  const last = undoStack[undoStack.length - 1];
  if (!last || last.signature !== snapshot.signature) {
    undoStack[undoStack.length - 1] = snapshot;
  }
}

function restoreSnapshot(snapshot, callbacks) {
  if (!snapshot) {
    return;
  }
  loadState(snapshot.data);
  state.typeCounts = snapshot.typeCounts ? { ...snapshot.typeCounts } : {};
  if (isValidSelection(snapshot.selection)) {
    state.selection = { ...snapshot.selection };
  } else {
    state.selection = null;
  }
  state.connecting = null;
  if (callbacks) {
    callbacks.renderModules();
    callbacks.updateWires();
    callbacks.renderProperties();
    callbacks.updateStatus();
  }
}

export function initHistory() {
  stopCoalescingHistory();
  undoStack = [makeSnapshot()];
  redoStack = [];
}

export function recordHistory() {
  if (isRestoring) {
    return;
  }
  stopCoalescingHistory();
  pushSnapshot(makeSnapshot());
}

export function recordCoalescedHistory(delay = COALESCED_HISTORY_DELAY) {
  if (isRestoring) {
    return;
  }
  const snapshot = makeSnapshot();
  const last = undoStack[undoStack.length - 1];
  if (!isCoalescingHistory && last && last.signature === snapshot.signature) {
    return;
  }

  if (isCoalescingHistory && undoStack.length > 0) {
    replaceCoalescedSnapshot(snapshot);
    trimHistoryStack(undoStack, 2);
  } else {
    pushSnapshot(snapshot);
    const current = undoStack[undoStack.length - 1];
    isCoalescingHistory = Boolean(current && current.signature === snapshot.signature);
  }

  if (coalescedHistoryTimer) {
    clearTimeout(coalescedHistoryTimer);
  }
  coalescedHistoryTimer = setTimeout(() => {
    coalescedHistoryTimer = null;
    isCoalescingHistory = false;
  }, delay);
}

export function undoHistory(callbacks) {
  if (undoStack.length < 2) {
    return false;
  }
  stopCoalescingHistory();
  isRestoring = true;
  try {
    const current = undoStack.pop();
    redoStack.push(current);
    trimHistoryStack(redoStack, 1);
    const snapshot = undoStack[undoStack.length - 1];
    restoreSnapshot(snapshot, callbacks);
    return true;
  } finally {
    isRestoring = false;
  }
}

export function redoHistory(callbacks) {
  if (redoStack.length === 0) {
    return false;
  }
  stopCoalescingHistory();
  isRestoring = true;
  try {
    const snapshot = redoStack.pop();
    undoStack.push(snapshot);
    restoreSnapshot(snapshot, callbacks);
    return true;
  } finally {
    isRestoring = false;
  }
}
