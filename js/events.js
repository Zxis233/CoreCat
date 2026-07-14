/**
 * Events - 事件处理
 * 包含拖拽、平移、缩放等事件处理
 */

import { state, canvas, moduleLayer, wireLayer, moduleElements, statusEl } from './state.js';
import { MODULE_LIBRARY, GRID_SIZE, DIAGRAM_LIMITS, MAX_IMPORT_JSON_LENGTH } from './constants.js';
import { getCanvasPoint, getModuleById, applyCanvasBackground, applyPortLabelSize, clamp, uid, ensureMuxGeometry } from './utils.js';
import { createModule, renderModule, renderModules, ensureMuxPorts, isKnownModuleType, resolveModuleType } from './module.js';
import { createWire, updateWires, updateWireGeometry, updateWiresForModule, updateConnectionPreview } from './wire.js';
import { renderProperties } from './properties.js';
import { describePortRef, getPortByRef, getPortPositionByRef } from './port.js';
import { serializeState, loadState, normalizeModuleImports, exportPng, exportSvg, refreshIdCounter, saveDiagramToStorage, scheduleAutoSave, flushAutoSave, getDocumentRevision, loadDiagramFromStorage, clearDiagramStorage } from './export.js';
import { initHistory, recordHistory, recordCoalescedHistory, undoHistory, redoHistory } from './history.js';
import { buildModuleClipboardData, createModuleFromClipboardData } from './module-transfer.js';
import {
  buildWireSnapContext,
  snapConnectionCursor,
  updateModuleDragPosition,
  updateWireDragGeometry,
} from './interaction-logic.js';

// 事件处理器引用
let onModuleDragHandler = null;
let endModuleDragHandler = null;
let onPanHandler = null;
let endPanHandler = null;
let onWireDragHandler = null;
let endWireDragHandler = null;
const MODULE_CLIPBOARD_OFFSET = 24;
const MODULE_DRAG_MIME = "application/x-corecat-module";
let moduleClipboard = null;
let pendingWireRenderFrame = null;
let pendingWireRenderUsesTimeout = false;
let pendingFullWireRender = false;
let pendingPreviewUpdate = false;
const pendingWireIds = new Set();
const pendingModuleIds = new Set();
let transientStatusTimer = null;
let autoSaveFailureVisible = false;

function isInteractiveShortcutTarget(target) {
  if (!target || typeof target.closest !== "function") {
    return false;
  }
  if (target.closest(".port")) {
    return true;
  }
  if (target.closest(".module, .wire-hit")) {
    return false;
  }
  return Boolean(target.closest(
    'input, textarea, select, button, a[href], [role="button"], [contenteditable]:not([contenteditable="false"])'
  ));
}

function pointerMatchesSession(session, event) {
  if (!session || !event || !Number.isFinite(event.pointerId)) {
    return Boolean(session);
  }
  return !Number.isFinite(session.pointerId) || session.pointerId === event.pointerId;
}

function captureSessionPointer(target, event) {
  if (!target || !event || !Number.isFinite(event.pointerId) || typeof target.setPointerCapture !== "function") {
    return null;
  }
  try {
    target.setPointerCapture(event.pointerId);
    return target;
  } catch (err) {
    return null;
  }
}

function releaseSessionPointer(session) {
  const target = session && session.captureTarget;
  if (!target || !Number.isFinite(session.pointerId) || typeof target.releasePointerCapture !== "function") {
    return;
  }
  try {
    if (typeof target.hasPointerCapture !== "function" || target.hasPointerCapture(session.pointerId)) {
      target.releasePointerCapture(session.pointerId);
    }
  } catch (err) {
    // Capture may already have been released after pointercancel or window blur.
  }
}

function cancelActiveGesture({ revert = true, render = true } = {}) {
  let modelChanged = false;
  let viewChanged = false;

  if (state.drag) {
    const drag = state.drag;
    if (revert) {
      const mod = getModuleById(drag.id);
      if (mod) {
        mod.x = drag.originX;
        mod.y = drag.originY;
        modelChanged = true;
      }
    }
    releaseSessionPointer(drag);
    state.drag = null;
    window.removeEventListener("pointermove", onModuleDragHandler);
    window.removeEventListener("pointerup", endModuleDragHandler);
    window.removeEventListener("pointercancel", endModuleDragHandler);
    window.removeEventListener("blur", endModuleDragHandler);
  }

  if (state.dragWire) {
    const dragWire = state.dragWire;
    if (revert) {
      const wire = state.wires.find((item) => item.id === dragWire.id);
      if (wire) {
        if (dragWire.segmentIndex !== undefined && Array.isArray(dragWire.origin)) {
          wire.bends = dragWire.origin.map((bend) => ({ ...bend }));
        } else if (dragWire.bendIndex >= 0 && Array.isArray(wire.bends) && dragWire.origin) {
          wire.bends[dragWire.bendIndex] = { ...dragWire.origin };
        } else {
          wire.bend = dragWire.origin;
        }
        modelChanged = true;
      }
    }
    releaseSessionPointer(dragWire);
    state.dragWire = null;
    window.removeEventListener("pointermove", onWireDragHandler);
    window.removeEventListener("pointerup", endWireDragHandler);
    window.removeEventListener("pointercancel", endWireDragHandler);
    window.removeEventListener("blur", endWireDragHandler);
  }

  if (state.pan) {
    const pan = state.pan;
    if (revert) {
      state.view.offsetX = pan.originX;
      state.view.offsetY = pan.originY;
      viewChanged = true;
    }
    releaseSessionPointer(pan);
    state.pan = null;
    canvas.classList.remove("panning");
    window.removeEventListener("pointermove", onPanHandler);
    window.removeEventListener("pointerup", endPanHandler);
    window.removeEventListener("pointercancel", endPanHandler);
    window.removeEventListener("blur", endPanHandler);
  }

  cancelScheduledWireRender();
  if (render && (modelChanged || viewChanged)) {
    applyViewTransform();
    doRenderModules();
    doUpdateWires();
    doRenderProperties();
    updateStatus();
  }
  return modelChanged || viewChanged;
}

function showStatusMessage(message, duration = 2200) {
  if (transientStatusTimer) {
    window.clearTimeout(transientStatusTimer);
  }
  const zoomText = `Zoom ${Math.round(state.view.scale * 100)}%`;
  statusEl.textContent = `${message} · ${zoomText}`;
  transientStatusTimer = window.setTimeout(() => {
    transientStatusTimer = null;
    updateStatus();
  }, duration);
}

function syncTypeCountsFromModules() {
  state.typeCounts = state.modules.reduce((counts, mod) => {
    counts[mod.type] = (counts[mod.type] || 0) + 1;
    return counts;
  }, {});
}

function parseImportJson(rawText) {
  if (typeof rawText !== "string" || rawText.length > MAX_IMPORT_JSON_LENGTH) {
    throw new RangeError(`JSON exceeds the ${Math.round(MAX_IMPORT_JSON_LENGTH / 1024 / 1024)} MB import limit.`);
  }
  return JSON.parse(rawText);
}

function requestWireRenderFrame(callback) {
  if (typeof window.requestAnimationFrame === "function") {
    pendingWireRenderUsesTimeout = false;
    return window.requestAnimationFrame(callback);
  }
  pendingWireRenderUsesTimeout = true;
  return window.setTimeout(callback, 16);
}

function cancelScheduledWireRender() {
  if (pendingWireRenderFrame === null) {
    return;
  }
  if (pendingWireRenderUsesTimeout) {
    window.clearTimeout(pendingWireRenderFrame);
  } else if (typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(pendingWireRenderFrame);
  }
  pendingWireRenderFrame = null;
  pendingFullWireRender = false;
  pendingPreviewUpdate = false;
  pendingWireIds.clear();
  pendingModuleIds.clear();
}

/**
 * 应用视图变换
 */
export function applyViewTransform() {
  const transform = `translate(${state.view.offsetX}px, ${state.view.offsetY}px) scale(${state.view.scale})`;
  moduleLayer.style.transform = transform;
  moduleLayer.style.transformOrigin = "0 0";
  wireLayer.style.transform = transform;
  wireLayer.style.transformOrigin = "0 0";

  const gridSize = Math.max(1, GRID_SIZE * state.view.scale);
  const gridOffsetX = ((state.view.offsetX % gridSize) + gridSize) % gridSize;
  const gridOffsetY = ((state.view.offsetY % gridSize) + gridSize) % gridSize;
  canvas.style.setProperty("--grid-size", `${gridSize}px`);
  canvas.style.setProperty("--grid-offset-x", `${gridOffsetX}px`);
  canvas.style.setProperty("--grid-offset-y", `${gridOffsetY}px`);
  const zoomOutButton = document.getElementById("btn-zoom-out");
  const zoomInButton = document.getElementById("btn-zoom-in");
  if (zoomOutButton) {
    zoomOutButton.disabled = state.view.scale <= 0.2;
  }
  if (zoomInButton) {
    zoomInButton.disabled = state.view.scale >= 2;
  }
}

/**
 * 更新状态栏
 */
export function updateStatus() {
  const zoomText = `Zoom ${Math.round(state.view.scale * 100)}%`;
  if (state.connecting) {
    statusEl.textContent = `Connecting from ${describePortRef(state.connecting.from)} · ${zoomText}`;
    return;
  }
  if (!state.selection) {
    statusEl.textContent = `Ready · ${zoomText}`;
    return;
  }
  if (state.selection.type === "module") {
    statusEl.textContent = `Module selected · ${zoomText}`;
    return;
  }
  if (state.selection.type === "wire") {
    statusEl.textContent = `Wire selected · ${zoomText}`;
  }
}

/**
 * 选择对象
 */
export function select(selection) {
  const previousSelection = state.selection;
  const restoreWireFocus = Boolean(
    selection &&
    selection.type === "wire" &&
    document.activeElement &&
    document.activeElement.classList &&
    document.activeElement.classList.contains("wire-hit")
  );
  state.selection = selection;

  const nextModuleMissing = selection && selection.type === "module" && !moduleElements.has(selection.id);
  if (nextModuleMissing) {
    doRenderModules();
  } else {
    if (previousSelection && previousSelection.type === "module") {
      const previousElement = moduleElements.get(previousSelection.id);
      previousElement?.classList.remove("selected");
      previousElement?.setAttribute("aria-current", "false");
    }
    if (selection && selection.type === "module") {
      const selectedElement = moduleElements.get(selection.id);
      selectedElement?.classList.add("selected");
      selectedElement?.setAttribute("aria-current", "true");
    }
  }

  if (
    (previousSelection && previousSelection.type === "wire") ||
    (selection && selection.type === "wire")
  ) {
    doUpdateWires();
    if (restoreWireFocus) {
      const nextWireElement = Array.from(wireLayer.querySelectorAll(".wire-hit"))
        .find((element) => element.getAttribute("data-wire-id") === selection.id);
      nextWireElement?.focus({ preventScroll: true });
    }
  }
  doRenderProperties();
  updateStatus();
}

/**
 * 删除选中对象
 */
export function deleteSelected() {
  if (!state.selection) {
    return;
  }
  cancelActiveGesture({ revert: true, render: false });
  if (state.selection.type === "module") {
    const id = state.selection.id;
    state.modules = state.modules.filter((item) => item.id !== id);
    state.wires = state.wires.filter((wire) => wire.from.moduleId !== id && wire.to.moduleId !== id);
  }
  if (state.selection.type === "wire") {
    state.wires = state.wires.filter((wire) => wire.id !== state.selection.id);
  }
  state.selection = null;
  state.connecting = null;
  doRenderModules();
  doUpdateWires();
  doRenderProperties();
  updateStatus();
  recordHistory();
  scheduleAutoSave();
}

/**
 * 重置视图
 */
export function resetView() {
  state.view.scale = 1;
  state.view.offsetX = 0;
  state.view.offsetY = 0;
  applyViewTransform();
  doUpdateWires();
  updateStatus();
}

function zoomViewAt(cursorX, cursorY, factor) {
  const oldScale = state.view.scale;
  const nextScale = clamp(oldScale * factor, 0.2, 2);
  if (nextScale === oldScale) {
    return false;
  }
  const worldX = (cursorX - state.view.offsetX) / oldScale;
  const worldY = (cursorY - state.view.offsetY) / oldScale;
  state.view.scale = nextScale;
  state.view.offsetX = cursorX - worldX * nextScale;
  state.view.offsetY = cursorY - worldY * nextScale;
  applyViewTransform();
  updateStatus();
  return true;
}

function zoomViewFromCenter(factor) {
  const rect = canvas.getBoundingClientRect();
  zoomViewAt(rect.width / 2, rect.height / 2, factor);
}

// 内部渲染函数
function doRenderModules() {
  renderModules(select, startModuleDrag, handlePortClick);
}

function doRenderSelectedModule() {
  if (
    state.selection &&
    state.selection.type === "module" &&
    renderModule(state.selection.id)
  ) {
    return;
  }
  doRenderModules();
}

function doUpdateWires() {
  cancelScheduledWireRender();
  updateWires(select, startWireDrag);
}

function doUpdatePropertyWires(options) {
  if (
    state.selection &&
    state.selection.type === "module" &&
    !(options && options.immediate) &&
    updateWiresForModule(state.selection.id)
  ) {
    return;
  }
  if (
    state.selection &&
    state.selection.type === "wire" &&
    !(options && options.immediate) &&
    updateWireGeometry(state.selection.id)
  ) {
    return;
  }
  doUpdateWires();
}

function scheduleUpdateWires(options = { full: true }) {
  if (options.full) {
    pendingFullWireRender = true;
  }
  if (options.preview) {
    pendingPreviewUpdate = true;
  }
  if (options.wireId) {
    pendingWireIds.add(options.wireId);
  }
  if (options.moduleId) {
    pendingModuleIds.add(options.moduleId);
  }
  if (pendingWireRenderFrame !== null) {
    return;
  }
  pendingWireRenderFrame = requestWireRenderFrame(() => {
    pendingWireRenderFrame = null;
    const fullRender = pendingFullWireRender;
    const previewUpdate = pendingPreviewUpdate;
    const wireIds = [...pendingWireIds];
    const moduleIds = [...pendingModuleIds];
    pendingFullWireRender = false;
    pendingPreviewUpdate = false;
    pendingWireIds.clear();
    pendingModuleIds.clear();

    let patched = true;
    if (!fullRender) {
      moduleIds.forEach((moduleId) => {
        patched = updateWiresForModule(moduleId) && patched;
        if (state.connecting && state.connecting.from.moduleId === moduleId) {
          patched = updateConnectionPreview() && patched;
        }
      });
      wireIds.forEach((wireId) => {
        patched = updateWireGeometry(wireId) && patched;
      });
      if (previewUpdate) {
        patched = updateConnectionPreview() && patched;
      }
    }
    if (fullRender || !patched) {
      updateWires(select, startWireDrag);
    }
  });
}

function doRenderProperties() {
  renderProperties(doRenderSelectedModule, doUpdatePropertyWires, updateStatus);
}

function getAllowedModuleType(type) {
  return isKnownModuleType(type) ? type : null;
}

function getSnappedConnectionCursor(fromRef, event) {
  const cursor = getCanvasPoint(event);
  const start = getPortPositionByRef(fromRef);
  const portRef = getPortByRef(fromRef);
  if (!start || !portRef) {
    return cursor;
  }
  return snapConnectionCursor(start, cursor, portRef.port.side, { mode: state.wireSnapMode });
}

function buildSnapContextForWire(wire) {
  const start = getPortPositionByRef(wire.from);
  const end = getPortPositionByRef(wire.to);
  const fromPortRef = getPortByRef(wire.from);
  const toPortRef = getPortByRef(wire.to);
  return buildWireSnapContext(
    start,
    end,
    fromPortRef ? fromPortRef.port.side : null,
    toPortRef ? toPortRef.port.side : null,
    { mode: state.wireSnapMode }
  );
}

function copySelectedModule(mod) {
  moduleClipboard = {
    data: buildModuleClipboardData(mod),
    pasteOffset: 0,
  };
}

function pasteClipboardModule() {
  if (!moduleClipboard || !moduleClipboard.data) {
    return;
  }
  if (state.modules.length >= DIAGRAM_LIMITS.modules) {
    showStatusMessage(`Module limit reached (${DIAGRAM_LIMITS.modules})`);
    return;
  }
  const data = moduleClipboard.data;
  const offset = MODULE_CLIPBOARD_OFFSET + moduleClipboard.pasteOffset;
  moduleClipboard.pasteOffset += MODULE_CLIPBOARD_OFFSET;
  const moduleItem = createModuleFromClipboardData(data, {
    createId: uid,
    offset,
    resolveType: resolveModuleType,
  });
  if (Array.isArray(moduleItem.ports) && moduleItem.ports.length > DIAGRAM_LIMITS.portsPerModule) {
    moduleItem.ports = moduleItem.ports.slice(0, DIAGRAM_LIMITS.portsPerModule);
  }
  state.modules.push(moduleItem);
  syncTypeCountsFromModules();
  select({ type: "module", id: moduleItem.id });
  recordHistory();
  scheduleAutoSave();
}

function nudgeSelectedModule(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  const deltas = {
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
  };
  const delta = deltas[event.key];
  if (!delta || !state.selection || state.selection.type !== "module") {
    return false;
  }
  const mod = getModuleById(state.selection.id);
  if (!mod) {
    return false;
  }

  event.preventDefault();
  mod.x = Math.round(mod.x + delta.x);
  mod.y = Math.round(mod.y + delta.y);

  const el = moduleElements.get(mod.id);
  if (el) {
    el.style.left = `${mod.x}px`;
    el.style.top = `${mod.y}px`;
  }

  scheduleUpdateWires({ moduleId: mod.id });
  doRenderProperties();
  recordCoalescedHistory();
  scheduleAutoSave();
  return true;
}

function addModulesFromJson(rawText) {
  let data;
  try {
    data = parseImportJson(rawText);
  } catch (err) {
    alert(err instanceof RangeError ? err.message : "Failed to parse JSON.");
    return false;
  }

  if (data && Array.isArray(data.modules) && Array.isArray(data.wires)) {
    alert("This looks like full diagram JSON. Use Import JSON instead.");
    return false;
  }

  const normalized = normalizeModuleImports(data, new Set(state.modules.map((mod) => mod.id)));
  if (normalized.warnings.length > 0) {
    console.warn("CoreCat module import issues:", normalized.warnings);
  }
  const remainingCapacity = Math.max(0, DIAGRAM_LIMITS.modules - state.modules.length);
  const newModules = normalized.modules.slice(0, remainingCapacity);
  const skippedForCapacity = normalized.modules.length - newModules.length;
  newModules.forEach((moduleItem) => {
    if (moduleItem.type === "mux") {
      if (!Array.isArray(moduleItem.ports) || moduleItem.ports.length === 0) {
        ensureMuxPorts(moduleItem);
      }
      ensureMuxGeometry(moduleItem);
    }
  });

  if (newModules.length === 0) {
    if (skippedForCapacity > 0) {
      showStatusMessage(`Module limit reached (${DIAGRAM_LIMITS.modules})`);
    } else {
      alert("No valid module data found.");
    }
    return false;
  }

  state.modules.push(...newModules);
  syncTypeCountsFromModules();
  refreshIdCounter();
  state.selection = { type: "module", id: newModules[newModules.length - 1].id };
  state.connecting = null;
  doRenderModules();
  doUpdateWires();
  doRenderProperties();
  updateStatus();
  recordHistory();
  scheduleAutoSave();
  if (skippedForCapacity > 0) {
    showStatusMessage(`Imported ${newModules.length}; skipped ${skippedForCapacity} at module limit`);
  } else if (normalized.warnings.length > 0) {
    showStatusMessage(`Imported with ${normalized.warnings.length} adjustment${normalized.warnings.length === 1 ? "" : "s"}`);
  }
  return true;
}

/**
 * 处理端口点击
 */
function handlePortClick(event, mod, port) {
  if (state.connecting) {
    if (state.connecting.from.moduleId === mod.id && state.connecting.from.portId === port.id) {
      state.connecting = null;
      doUpdateWires();
      updateStatus();
      return;
    }
    const beforeCount = state.wires.length;
    const created = createWire(state.connecting.from, { moduleId: mod.id, portId: port.id }, select);
    state.connecting = null;
    doUpdateWires();
    if (created === null || state.wires.length === beforeCount) {
      showStatusMessage(`Wire limit reached (${DIAGRAM_LIMITS.wires})`);
      return;
    }
    updateStatus();
    recordHistory();
    scheduleAutoSave();
    return;
  }

  const fromRef = { moduleId: mod.id, portId: port.id };
  state.connecting = {
    from: fromRef,
    cursor: getPortPositionByRef(fromRef) || getSnappedConnectionCursor(fromRef, event),
  };
  doUpdateWires();
  updateStatus();
}

/**
 * 开始模块拖拽
 */
function startModuleDrag(event, mod) {
  event.preventDefault();
  if (state.drag || state.pan || state.dragWire) {
    return;
  }
  state.drag = {
    id: mod.id,
    startX: event.clientX,
    startY: event.clientY,
    originX: mod.x,
    originY: mod.y,
    axisLock: null,
    pointerId: event.pointerId,
    captureTarget: captureSessionPointer(moduleLayer, event),
  };

  onModuleDragHandler = onModuleDrag;
  endModuleDragHandler = endModuleDrag;

  window.addEventListener("pointermove", onModuleDragHandler);
  window.addEventListener("pointerup", endModuleDragHandler);
  window.addEventListener("pointercancel", endModuleDragHandler);
  window.addEventListener("blur", endModuleDragHandler);
}

/**
 * 模块拖拽中
 */
function onModuleDrag(event) {
  if (!pointerMatchesSession(state.drag, event)) {
    return;
  }
  const mod = getModuleById(state.drag.id);
  if (!mod) {
    return;
  }
  updateModuleDragPosition(mod, state.drag, event, state.view.scale);
  const el = moduleElements.get(mod.id);
  if (el) {
    el.style.left = `${mod.x}px`;
    el.style.top = `${mod.y}px`;
  }
  scheduleUpdateWires({ moduleId: mod.id });
}

/**
 * 结束模块拖拽
 */
function endModuleDrag(event) {
  if (!pointerMatchesSession(state.drag, event)) {
    return;
  }
  const drag = state.drag;
  state.drag = null;
  releaseSessionPointer(drag);
  window.removeEventListener("pointermove", onModuleDragHandler);
  window.removeEventListener("pointerup", endModuleDragHandler);
  window.removeEventListener("pointercancel", endModuleDragHandler);
  window.removeEventListener("blur", endModuleDragHandler);
  doUpdateWires();
  doRenderProperties();
  recordHistory();
  scheduleAutoSave();
}

/**
 * 开始平移
 */
function startPan(event) {
  event.preventDefault();
  if (state.drag || state.pan || state.dragWire) {
    return;
  }
  canvas.classList.add("panning");
  state.pan = {
    startX: event.clientX,
    startY: event.clientY,
    originX: state.view.offsetX,
    originY: state.view.offsetY,
    pointerId: event.pointerId,
    captureTarget: captureSessionPointer(canvas, event),
    isTouch: event.pointerType === "touch",
    moved: false,
  };

  onPanHandler = onPan;
  endPanHandler = endPan;

  window.addEventListener("pointermove", onPanHandler);
  window.addEventListener("pointerup", endPanHandler);
  window.addEventListener("pointercancel", endPanHandler);
  window.addEventListener("blur", endPanHandler);
}

/**
 * 平移中
 */
function onPan(event) {
  if (!pointerMatchesSession(state.pan, event)) {
    return;
  }
  const deltaX = event.clientX - state.pan.startX;
  const deltaY = event.clientY - state.pan.startY;
  if (state.pan.isTouch && !state.pan.moved) {
    if (Math.hypot(deltaX, deltaY) < 6) {
      return;
    }
    state.pan.moved = true;
  }
  state.view.offsetX = state.pan.originX + deltaX;
  state.view.offsetY = state.pan.originY + deltaY;
  applyViewTransform();
}

/**
 * 结束平移
 */
function endPan(event) {
  if (!pointerMatchesSession(state.pan, event)) {
    return;
  }
  const pan = state.pan;
  const clearSelection = pan.isTouch && !pan.moved && event && event.type === "pointerup";
  state.pan = null;
  releaseSessionPointer(pan);
  canvas.classList.remove("panning");
  window.removeEventListener("pointermove", onPanHandler);
  window.removeEventListener("pointerup", endPanHandler);
  window.removeEventListener("pointercancel", endPanHandler);
  window.removeEventListener("blur", endPanHandler);
  if (clearSelection) {
    const hadConnecting = Boolean(state.connecting);
    state.connecting = null;
    select(null);
    if (hadConnecting) {
      doUpdateWires();
    }
  }
}

/**
 * 开始连线拖拽
 * @param {Event} event - 鼠标事件
 * @param {Object} wire - 连线对象
 * @param {number} bendIndex - 弯折点索引（-1 表示简单路由）
 * @param {number} segmentIndex - 线段索引（智能路由用）
 * @param {boolean} isHorizontal - 线段是否为水平方向（智能路由用）
 */
function startWireDrag(event, wire, bendIndex = -1, segmentIndex = undefined, isHorizontal = undefined) {
  event.preventDefault();
  if (state.drag || state.pan || state.dragWire) {
    return;
  }
  let origin;

  if (segmentIndex !== undefined && Array.isArray(wire.bends)) {
    // 智能路由线段拖拽：保存所有弯折点的原始位置
    // 线段结构：start -> bends[0] -> bends[1] -> ... -> bends[n-1] -> end
    // 线段 0 连接 start 和 bends[0]，只影响 bends[0]
    // 线段 i (0 < i < n) 连接 bends[i-1] 和 bends[i]，影响两个弯折点
    // 线段 n 连接 bends[n-1] 和 end，只影响 bends[n-1]
    origin = wire.bends.map(b => ({ x: b.x, y: b.y }));
  } else if (bendIndex >= 0 && Array.isArray(wire.bends)) {
    origin = { x: wire.bends[bendIndex].x, y: wire.bends[bendIndex].y };
  } else {
    origin = wire.bend;
  }

  state.dragWire = {
    id: wire.id,
    route: wire.route,
    bendIndex: bendIndex,
    segmentIndex: segmentIndex,
    isHorizontal: isHorizontal,
    origin: origin,
    startX: event.clientX,
    startY: event.clientY,
    snapContext: buildSnapContextForWire(wire),
    pointerId: event.pointerId,
    captureTarget: captureSessionPointer(wireLayer, event),
  };

  onWireDragHandler = onWireDrag;
  endWireDragHandler = endWireDrag;

  window.addEventListener("pointermove", onWireDragHandler);
  window.addEventListener("pointerup", endWireDragHandler);
  window.addEventListener("pointercancel", endWireDragHandler);
  window.addEventListener("blur", endWireDragHandler);
}

/**
 * 连线拖拽中
 */
function onWireDrag(event) {
  if (!pointerMatchesSession(state.dragWire, event)) {
    return;
  }
  const wire = state.wires.find((item) => item.id === state.dragWire.id);
  if (!wire) {
    return;
  }

  updateWireDragGeometry(wire, state.dragWire, event.clientX, event.clientY, state.view.scale);
  scheduleUpdateWires({ wireId: wire.id });
}

/**
 * 结束连线拖拽
 */
function endWireDrag(event) {
  if (!pointerMatchesSession(state.dragWire, event)) {
    return;
  }
  const dragWire = state.dragWire;
  state.dragWire = null;
  releaseSessionPointer(dragWire);
  window.removeEventListener("pointermove", onWireDragHandler);
  window.removeEventListener("pointerup", endWireDragHandler);
  window.removeEventListener("pointercancel", endWireDragHandler);
  window.removeEventListener("blur", endWireDragHandler);
  doUpdateWires();
  doRenderProperties();
  recordHistory();
  scheduleAutoSave();
}

/**
 * 初始化调色板
 */
export function initPalette() {
  const paletteItems = document.querySelectorAll(".palette-item");
  paletteItems.forEach((item) => {
    item.addEventListener("dragstart", (event) => {
      const type = getAllowedModuleType(item.dataset.type);
      if (!type) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData(MODULE_DRAG_MIME, type);
      event.dataTransfer.effectAllowed = "copy";
    });
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        item.click();
      }
    });
    item.addEventListener("click", () => {
      const type = getAllowedModuleType(item.dataset.type);
      if (!type) {
        return;
      }
      const library = MODULE_LIBRARY[type];
      const rect = canvas.getBoundingClientRect();
      const centerX = (rect.width / 2 - state.view.offsetX) / state.view.scale;
      const centerY = (rect.height / 2 - state.view.offsetY) / state.view.scale;
      const beforeCount = state.modules.length;
      const created = createModule(type, centerX - library.width / 2, centerY - library.height / 2, select);
      if (created === null || state.modules.length === beforeCount) {
        showStatusMessage(`Module limit reached (${DIAGRAM_LIMITS.modules})`);
        return;
      }
      recordHistory();
      scheduleAutoSave();
    });
  });

  canvas.addEventListener("dragover", (event) => {
    if (!event.dataTransfer) {
      return;
    }
    if (Array.from(event.dataTransfer.types || []).includes(MODULE_DRAG_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  });

  canvas.addEventListener("drop", (event) => {
    if (!event.dataTransfer) {
      return;
    }
    const type = getAllowedModuleType(event.dataTransfer.getData(MODULE_DRAG_MIME));
    if (!type) {
      return;
    }
    event.preventDefault();
    const library = MODULE_LIBRARY[type];
    const point = getCanvasPoint(event);
    const beforeCount = state.modules.length;
    const created = createModule(type, point.x - library.width / 2, point.y - library.height / 2, select);
    if (created === null || state.modules.length === beforeCount) {
      showStatusMessage(`Module limit reached (${DIAGRAM_LIMITS.modules})`);
      return;
    }
    recordHistory();
    scheduleAutoSave();
  });
}

/**
 * 初始化按钮
 */
export function initButtons() {
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modal-title");
  const modalText = document.getElementById("modal-text");
  const modalCopy = document.getElementById("modal-copy");
  const modalClose = document.getElementById("modal-close");
  const modalApply = document.getElementById("modal-apply");
  const importModuleButton = document.getElementById("btn-import-module");
  const exportPngButton = document.getElementById("btn-export-png");
  const exportSvgButton = document.getElementById("btn-export-svg");
  const bgToggleButton = document.getElementById("btn-bg-toggle");
  const demoEscutervButton = document.getElementById("btn-demo-escuterv");
  const demoLfsrButton = document.getElementById("btn-demo-lfsr");
  const zoomOutButton = document.getElementById("btn-zoom-out");
  const zoomInButton = document.getElementById("btn-zoom-in");
  const app = document.querySelector(".app");
  let modalMode = "export";
  let copyStatusTimer = null;
  let modalReturnFocus = null;
  let openDisclosure = null;
  let demoLoadGeneration = 0;

  const disclosures = Array.from(document.querySelectorAll(".dropdown-export"))
    .map((wrapper) => {
      const trigger = wrapper.querySelector("button[aria-controls]");
      const menu = trigger ? document.getElementById(trigger.getAttribute("aria-controls")) : null;
      return trigger && menu ? { wrapper, trigger, menu } : null;
    })
    .filter(Boolean);

  const closeDisclosure = (entry, restoreFocus = false) => {
    if (!entry) {
      return;
    }
    entry.wrapper.classList.remove("is-open");
    entry.trigger.setAttribute("aria-expanded", "false");
    if (openDisclosure === entry) {
      openDisclosure = null;
    }
    if (restoreFocus) {
      entry.trigger.focus();
    }
  };

  const closeAllDisclosures = (restoreFocus = false) => {
    const activeEntry = openDisclosure;
    disclosures.forEach((entry) => closeDisclosure(entry, false));
    if (restoreFocus && activeEntry) {
      activeEntry.trigger.focus();
    }
  };

  const openDisclosureMenu = (entry, focusFirst = false) => {
    if (openDisclosure && openDisclosure !== entry) {
      closeDisclosure(openDisclosure, false);
    }
    entry.wrapper.classList.add("is-open");
    entry.trigger.setAttribute("aria-expanded", "true");
    openDisclosure = entry;
    if (focusFirst) {
      const firstItem = entry.menu.querySelector("button:not([disabled])");
      if (firstItem) {
        firstItem.focus();
      }
    }
  };

  disclosures.forEach((entry) => {
    entry.trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (entry.trigger.getAttribute("aria-expanded") === "true") {
        closeDisclosure(entry, false);
      } else {
        openDisclosureMenu(entry, event.detail === 0);
      }
    });
    entry.trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openDisclosureMenu(entry, true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeDisclosure(entry, true);
      }
    });
    entry.menu.addEventListener("keydown", (event) => {
      const items = Array.from(entry.menu.querySelectorAll("button:not([disabled])"));
      const currentIndex = items.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        closeDisclosure(entry, true);
      } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length > 0) {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = currentIndex < 0
          ? 0
          : (currentIndex + direction + items.length) % items.length;
        items[nextIndex].focus();
      }
    });
    entry.menu.addEventListener("click", (event) => {
      if (!event.target.closest("button")) {
        return;
      }
      window.setTimeout(() => {
        if (openDisclosure === entry) {
          closeDisclosure(entry, modal.classList.contains("hidden"));
        }
      }, 0);
    });
    entry.wrapper.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (openDisclosure === entry && !entry.wrapper.contains(document.activeElement)) {
          closeDisclosure(entry, false);
        }
      }, 0);
    });
  });

  document.addEventListener("pointerdown", (event) => {
    if (openDisclosure && !openDisclosure.wrapper.contains(event.target)) {
      closeDisclosure(openDisclosure, false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openDisclosure) {
      event.preventDefault();
      closeDisclosure(openDisclosure, true);
    }
  });

  const diagramCallbacks = {
    renderModules: doRenderModules,
    updateWires: doUpdateWires,
    renderProperties: doRenderProperties,
    updateStatus: updateStatus,
  };

  const openModal = (mode) => {
    modalReturnFocus = openDisclosure ? openDisclosure.trigger : document.activeElement;
    closeAllDisclosures(false);
    modalMode = mode;
    modalText.placeholder = "";
    modalText.setCustomValidity("");
    modalCopy.textContent = "Copy";
    if (copyStatusTimer) {
      clearTimeout(copyStatusTimer);
      copyStatusTimer = null;
    }
    if (mode === "export") {
      modalTitle.textContent = "Export JSON";
      modalText.setAttribute("aria-label", "Exported diagram JSON");
      modalText.value = JSON.stringify(serializeState(), null, 2);
      modalText.readOnly = true;
      modalCopy.style.display = "inline-flex";
      modalApply.style.display = "none";
    } else if (mode === "import-module") {
      modalTitle.textContent = "Import Module JSON";
      modalText.setAttribute("aria-label", "Module JSON to import");
      modalText.value = "";
      modalText.readOnly = false;
      modalText.placeholder = "Paste a module JSON object here";
      modalCopy.style.display = "none";
      modalApply.style.display = "inline-flex";
    } else {
      modalTitle.textContent = "Import JSON";
      modalText.setAttribute("aria-label", "Diagram JSON to import");
      modalText.value = "";
      modalText.readOnly = false;
      modalText.placeholder = "Paste diagram JSON here";
      modalCopy.style.display = "none";
      modalApply.style.display = "inline-flex";
    }
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    if (app) {
      app.inert = true;
    }
    modalText.focus({ preventScroll: true });
  };

  const closeModal = () => {
    if (modal.classList.contains("hidden")) {
      return;
    }
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    if (app) {
      app.inert = false;
    }
    const returnTarget = modalReturnFocus;
    modalReturnFocus = null;
    if (returnTarget && returnTarget.isConnected && typeof returnTarget.focus === "function") {
      returnTarget.focus({ preventScroll: true });
    }
  };

  const setCopyStatus = (label) => {
    modalCopy.textContent = label;
    if (copyStatusTimer) {
      clearTimeout(copyStatusTimer);
    }
    copyStatusTimer = setTimeout(() => {
      copyStatusTimer = null;
      modalCopy.textContent = "Copy";
    }, 1200);
  };

  const copyModalTextFallback = () => {
    const activeElement = document.activeElement;
    modalText.focus();
    modalText.select();
    modalText.setSelectionRange(0, modalText.value.length);
    const copied = document.execCommand("copy");
    if (activeElement && typeof activeElement.focus === "function") {
      activeElement.focus();
    }
    if (!copied) {
      throw new Error("Copy command failed.");
    }
  };

  const copyModalText = async () => {
    if (modalMode !== "export") {
      return;
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(modalText.value);
      } else {
        copyModalTextFallback();
      }
      setCopyStatus("Copied");
    } catch (err) {
      try {
        copyModalTextFallback();
        setCopyStatus("Copied");
      } catch (fallbackErr) {
        alert("Failed to copy JSON.");
      }
    }
  };

  const loadDemo = async (path) => {
    const generation = ++demoLoadGeneration;
    const startingRevision = getDocumentRevision();
    try {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch demo: ${path}`);
      }
      const data = await response.json();
      if (
        generation !== demoLoadGeneration ||
        startingRevision !== getDocumentRevision() ||
        state.drag ||
        state.dragWire
      ) {
        return;
      }
      cancelActiveGesture({ revert: true, render: false });
      if (!loadState(data, diagramCallbacks)) {
        throw new Error(`Invalid demo data: ${path}`);
      }
      resetView();
      recordHistory();
      scheduleAutoSave();
    } catch (err) {
      if (generation === demoLoadGeneration) {
        alert("Failed to load demo.");
      }
    }
  };

  document.getElementById("btn-export").addEventListener("click", () => openModal("export"));
  document.getElementById("btn-import").addEventListener("click", () => openModal("import"));
  if (importModuleButton) {
    importModuleButton.addEventListener("click", () => openModal("import-module"));
  }

  modalCopy.addEventListener("click", copyModalText);
  modalClose.addEventListener("click", closeModal);
  modalText.addEventListener("input", () => modalText.setCustomValidity(""));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });
  modal.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const focusable = Array.from(modal.querySelectorAll(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((element) => !element.hidden && element.style.display !== "none");
    if (focusable.length === 0) {
      event.preventDefault();
      modal.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  modalApply.addEventListener("click", () => {
    if (modalMode === "import") {
      try {
        const data = parseImportJson(modalText.value);
        cancelActiveGesture({ revert: true, render: false });
        if (!loadState(data, diagramCallbacks)) {
          return;
        }
        resetView();
        recordHistory();
        scheduleAutoSave();
        closeModal();
      } catch (err) {
        alert(err instanceof RangeError ? err.message : "Failed to parse JSON.");
      }
      return;
    }
    if (modalMode === "import-module") {
      if (addModulesFromJson(modalText.value)) {
        closeModal();
      } else if (state.modules.length >= DIAGRAM_LIMITS.modules) {
        modalText.setCustomValidity(`Module limit reached (${DIAGRAM_LIMITS.modules}).`);
        modalText.reportValidity();
      }
    }
  });

  document.getElementById("btn-save").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const result = await Promise.resolve(saveDiagramToStorage());
      const succeeded = typeof result === "boolean"
        ? result
        : result && typeof result === "object" && "ok" in result
          ? Boolean(result.ok)
          : result && typeof result === "object" && "success" in result
            ? Boolean(result.success)
            : !(result && typeof result === "object" && result.error);
      if (succeeded) {
        const message = result && typeof result === "object" && typeof result.message === "string"
          ? result.message
          : "Saved locally";
        showStatusMessage(message);
      } else {
        const detail = result && typeof result === "object"
          ? (result.message || (result.error && result.error.message))
          : "Local storage is unavailable";
        showStatusMessage(`Save failed${detail ? `: ${detail}` : ""}`, 4000);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      showStatusMessage(`Save failed: ${detail}`, 4000);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });

  zoomOutButton?.addEventListener("click", () => zoomViewFromCenter(1 / 1.1));
  zoomInButton?.addEventListener("click", () => zoomViewFromCenter(1.1));

  // document.getElementById("btn-load").addEventListener("click", () => {
  //   const loaded = loadDiagramFromStorage({
  //     renderModules: doRenderModules,
  //     updateWires: doUpdateWires,
  //     renderProperties: doRenderProperties,
  //     updateStatus: updateStatus,
  //   });
  //   if (!loaded) {
  //     alert("No saved diagram found.");
  //     return;
  //   }
  // });

  if (demoEscutervButton) {
    demoEscutervButton.addEventListener("click", () => {
      loadDemo("examples/escuterv.json");
    });
  }

  if (demoLfsrButton) {
    demoLfsrButton.addEventListener("click", () => {
      loadDemo("examples/LFSR.json");
    });
  }

  document.getElementById("btn-clear").addEventListener("click", () => {
    if (!confirm("Clear the canvas?")) {
      return;
    }
    demoLoadGeneration += 1;
    cancelActiveGesture({ revert: true, render: false });
    state.modules = [];
    state.wires = [];
    state.selection = null;
    state.connecting = null;
    doRenderModules();
    doUpdateWires();
    doRenderProperties();
    updateStatus();
    recordHistory();
    const clearResult = clearDiagramStorage();
    if (!clearResult.ok) {
      const reason = clearResult.error && clearResult.error.message ? `: ${clearResult.error.message}` : "";
      showStatusMessage(`Canvas cleared, but saved data could not be removed${reason}`, 5000);
    }
  });

  const updateBgButton = () => {
    bgToggleButton.textContent = state.export.transparent ? "BG: Trans" : "BG: Solid";
  };

  exportPngButton.addEventListener("click", exportPng);
  exportSvgButton.addEventListener("click", exportSvg);
  bgToggleButton.addEventListener("click", () => {
    state.export.transparent = !state.export.transparent;
    updateBgButton();
  });
  updateBgButton();
}

/**
 * 初始化画布事件
 */
export function initCanvasEvents() {
  canvas.addEventListener("mousedown", (event) => {
    if (event.button === 1) {
      event.preventDefault();
    }
  });

  canvas.addEventListener("auxclick", (event) => {
    if (event.button === 1) {
      event.preventDefault();
    }
  });

  canvas.addEventListener("pointerdown", (event) => {
    const targetIsDiagramObject = Boolean(
      event.target.closest(".module") || event.target.closest(".wire-hit")
    );
    if (event.pointerType === "touch" && event.button === 0 && state.connecting && !targetIsDiagramObject) {
      state.connecting = null;
      doUpdateWires();
      updateStatus();
      return;
    }
    if (event.button === 1 || (event.pointerType === "touch" && event.button === 0)) {
      startPan(event);
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (targetIsDiagramObject) {
      return;
    }
    state.selection = null;
    state.connecting = null;
    doRenderModules();
    doUpdateWires();
    doRenderProperties();
    updateStatus();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state.connecting) {
      return;
    }
    state.connecting.cursor = getSnappedConnectionCursor(state.connecting.from, event);
    scheduleUpdateWires({ preview: true });
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const cursorX = event.clientX - rect.left;
        const cursorY = event.clientY - rect.top;
        const factor = event.deltaY > 0 ? 1 / 1.1 : 1.1;
        zoomViewAt(cursorX, cursorY, factor);
        return;
      }

      event.preventDefault();
      const deltaX = event.deltaX || 0;
      const deltaY = event.deltaY || 0;
      if (event.shiftKey) {
        const panX = deltaX !== 0 ? deltaX : deltaY;
        if (panX === 0) {
          return;
        }
        state.view.offsetX -= panX;
      } else {
        if (deltaY === 0) {
          return;
        }
        state.view.offsetY -= deltaY;
      }
      applyViewTransform();
    },
    { passive: false }
  );
}

/**
 * 初始化键盘事件
 */
export function initKeyboardEvents() {
  const historyCallbacks = {
    renderModules: doRenderModules,
    updateWires: doUpdateWires,
    renderProperties: doRenderProperties,
    updateStatus: updateStatus,
  };

  document.addEventListener("keydown", (event) => {
    const portEscape = event.key === "Escape" && event.target?.closest?.(".port");
    if (
      !portEscape &&
      (isInteractiveShortcutTarget(event.target) || isInteractiveShortcutTarget(document.activeElement))
    ) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      cancelActiveGesture({ revert: true, render: false });
      const handled = event.shiftKey ? redoHistory(historyCallbacks) : undoHistory(historyCallbacks);
      if (handled) {
        scheduleAutoSave();
      }
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      cancelActiveGesture({ revert: true, render: false });
      if (redoHistory(historyCallbacks)) {
        scheduleAutoSave();
      }
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      if (state.selection && state.selection.type === "module") {
        const mod = getModuleById(state.selection.id);
        if (mod) {
          copySelectedModule(mod);
          event.preventDefault();
        }
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      if (moduleClipboard && moduleClipboard.data) {
        pasteClipboardModule();
        event.preventDefault();
      }
      return;
    }
    if (nudgeSelectedModule(event)) {
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (state.selection) {
        event.preventDefault();
        deleteSelected();
      }
    }
    if (event.key === "Escape") {
      const cancelledGesture = cancelActiveGesture({ revert: true, render: true });
      state.connecting = null;
      if (!cancelledGesture) {
        doUpdateWires();
      }
      updateStatus();
    }
  });
}

/**
 * 初始化窗口事件
 */
export function initWindowEvents() {
  window.addEventListener("resize", () => {
    scheduleUpdateWires();
  });
  window.addEventListener("corecat:storage-status", (event) => {
    const detail = event && event.detail;
    if (!detail) {
      return;
    }
    if (detail.source === "restore" && !detail.ok) {
      const reason = detail.error && detail.error.message ? `: ${detail.error.message}` : "";
      showStatusMessage(`Saved diagram could not be restored${reason}`, 6000);
      return;
    }
    if (detail.source !== "autosave") {
      return;
    }
    if (detail.ok) {
      autoSaveFailureVisible = false;
      return;
    }
    if (!autoSaveFailureVisible) {
      autoSaveFailureVisible = true;
      const reason = detail.error && detail.error.message ? `: ${detail.error.message}` : "";
      showStatusMessage(`Autosave failed${reason}`, 5000);
    }
  });
  window.addEventListener("corecat:import-warning", (event) => {
    const warnings = event && event.detail && event.detail.warnings;
    if (Array.isArray(warnings) && warnings.length > 0) {
      showStatusMessage(`Imported with ${warnings.length} adjustment${warnings.length === 1 ? "" : "s"}`, 4000);
    }
  });
  window.addEventListener("pagehide", () => {
    const hadDocumentGesture = Boolean(state.drag || state.dragWire);
    cancelActiveGesture({ revert: false, render: false });
    if (hadDocumentGesture) {
      saveDiagramToStorage();
    } else {
      flushAutoSave();
    }
  });
}

/**
 * 初始化状态栏点击
 */
export function initStatusClick() {
  document.getElementById("btn-reset-view")?.addEventListener("click", resetView);
}

/**
 * 初始化应用
 */
export function initApp() {
  initPalette();
  initButtons();
  initCanvasEvents();
  initKeyboardEvents();
  initWindowEvents();
  initStatusClick();
  applyViewTransform();
  const loaded = loadDiagramFromStorage({
    renderModules: doRenderModules,
    updateWires: doUpdateWires,
    renderProperties: doRenderProperties,
    updateStatus: updateStatus,
  });
  if (!loaded) {
    applyCanvasBackground();
    doRenderModules();
    doUpdateWires();
    doRenderProperties();
    updateStatus();
  }
  applyPortLabelSize();
  initHistory();
}
