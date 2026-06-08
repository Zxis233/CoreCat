/**
 * History - undo/redo snapshots
 * Keeps the last configured changes plus the current state.
 */

import { HISTORY_MAX_STEPS } from './constants.js';
import { state } from './state.js';
import { serializeState, loadState } from './export.js';

const MAX_HISTORY = Math.max(
  1,
  Math.round(Number.isFinite(HISTORY_MAX_STEPS) ? HISTORY_MAX_STEPS : 0) + 1
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
  const data = serializeState();
  const typeCounts = { ...state.typeCounts };
  return {
    data,
    typeCounts,
    selection: state.selection ? { ...state.selection } : null,
    signature: JSON.stringify({ data, typeCounts }),
  };
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
  if (undoStack.length > MAX_HISTORY) {
    undoStack.shift();
  }
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
  const current = undoStack.pop();
  redoStack.push(current);
  const snapshot = undoStack[undoStack.length - 1];
  restoreSnapshot(snapshot, callbacks);
  isRestoring = false;
  return true;
}

export function redoHistory(callbacks) {
  if (redoStack.length === 0) {
    return false;
  }
  stopCoalescingHistory();
  isRestoring = true;
  const snapshot = redoStack.pop();
  undoStack.push(snapshot);
  restoreSnapshot(snapshot, callbacks);
  isRestoring = false;
  return true;
}
