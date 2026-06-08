/**
 * Events - 事件处理
 * 包含拖拽、平移、缩放等事件处理
 */

import { state, canvas, moduleLayer, wireLayer, moduleElements, statusEl } from './state.js';
import { MODULE_LIBRARY } from './constants.js';
import { getCanvasPoint, getModuleById, applyCanvasBackground, applyPortLabelSize, clamp, isTypingTarget, uid, ensureMuxGeometry } from './utils.js';
import { createModule, renderModules, ensureMuxPorts } from './module.js';
import { createWire, updateWires, syncSvgSize } from './wire.js';
import { renderProperties } from './properties.js';
import { describePortRef } from './port.js';
import { serializeState, loadState, normalizeModuleImports, exportPng, exportSvg, refreshIdCounter, saveDiagramToStorage, scheduleAutoSave, loadDiagramFromStorage, clearDiagramStorage } from './export.js';
import { initHistory, recordHistory, undoHistory, redoHistory } from './history.js';

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
  state.selection = selection;
  doRenderModules();
  doUpdateWires();
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

// 内部渲染函数
function doRenderModules() {
  renderModules(select, startModuleDrag, handlePortClick);
}

function doUpdateWires() {
  cancelScheduledWireRender();
  updateWires(select, startWireDrag);
}

function scheduleUpdateWires() {
  if (pendingWireRenderFrame !== null) {
    return;
  }
  pendingWireRenderFrame = requestWireRenderFrame(() => {
    pendingWireRenderFrame = null;
    updateWires(select, startWireDrag);
  });
}

function doRenderProperties() {
  renderProperties(doRenderModules, doUpdateWires, updateStatus);
}

function copySelectedModule(mod) {
  moduleClipboard = {
    data: {
      type: mod.type,
      name: mod.name,
      x: mod.x,
      y: mod.y,
      width: mod.width,
      height: mod.height,
      nameSize: mod.nameSize,
      showType: mod.showType,
      fill: mod.fill,
      strokeColor: mod.strokeColor,
      strokeWidth: mod.strokeWidth,
      muxInputs: mod.muxInputs,
      muxControlSide: mod.muxControlSide,
      ports: Array.isArray(mod.ports)
        ? mod.ports.map((port) => ({
          name: port.name,
          side: port.side,
          offset: port.offset,
          clock: port.clock === true,
        }))
        : [],
    },
    pasteOffset: 0,
  };
}

function pasteClipboardModule() {
  if (!moduleClipboard || !moduleClipboard.data) {
    return;
  }
  const data = moduleClipboard.data;
  const offset = MODULE_CLIPBOARD_OFFSET + moduleClipboard.pasteOffset;
  moduleClipboard.pasteOffset += MODULE_CLIPBOARD_OFFSET;
  const moduleItem = {
    id: uid("mod"),
    type: data.type,
    name: data.name,
    x: Math.round((data.x || 0) + offset),
    y: Math.round((data.y || 0) + offset),
    width: data.width,
    height: data.height,
    nameSize: data.nameSize,
    showType: data.showType,
    fill: data.fill,
    strokeColor: data.strokeColor,
    strokeWidth: data.strokeWidth,
    muxInputs: data.muxInputs,
    muxControlSide: data.muxControlSide,
    ports: Array.isArray(data.ports)
      ? data.ports.map((port) => ({
        id: uid("port"),
        name: port.name,
        side: port.side,
        offset: port.offset,
        clock: port.clock === true,
      }))
      : [],
  };
  state.modules.push(moduleItem);
  select({ type: "module", id: moduleItem.id });
  recordHistory();
  scheduleAutoSave();
}

function addModulesFromJson(rawText) {
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    alert("Failed to parse JSON.");
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
  const newModules = normalized.modules;
  newModules.forEach((moduleItem) => {
    if (moduleItem.type === "mux") {
      if (!Array.isArray(moduleItem.ports) || moduleItem.ports.length === 0) {
        ensureMuxPorts(moduleItem);
      }
      ensureMuxGeometry(moduleItem);
    }
  });

  if (newModules.length === 0) {
    alert("No valid module data found.");
    return false;
  }

  state.modules.push(...newModules);
  refreshIdCounter();
  state.selection = { type: "module", id: newModules[newModules.length - 1].id };
  state.connecting = null;
  doRenderModules();
  doUpdateWires();
  doRenderProperties();
  updateStatus();
  recordHistory();
  scheduleAutoSave();
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
    createWire(state.connecting.from, { moduleId: mod.id, portId: port.id }, select);
    state.connecting = null;
    doUpdateWires();
    updateStatus();
    recordHistory();
    scheduleAutoSave();
    return;
  }

  state.connecting = {
    from: { moduleId: mod.id, portId: port.id },
    cursor: getCanvasPoint(event),
  };
  doUpdateWires();
  updateStatus();
}

/**
 * 开始模块拖拽
 */
function startModuleDrag(event, mod) {
  state.drag = {
    id: mod.id,
    startX: event.clientX,
    startY: event.clientY,
    originX: mod.x,
    originY: mod.y,
    axisLock: null,
  };

  onModuleDragHandler = onModuleDrag;
  endModuleDragHandler = endModuleDrag;

  window.addEventListener("pointermove", onModuleDragHandler);
  window.addEventListener("pointerup", endModuleDragHandler);
}

/**
 * 模块拖拽中
 */
function onModuleDrag(event) {
  if (!state.drag) {
    return;
  }
  const mod = getModuleById(state.drag.id);
  if (!mod) {
    return;
  }
  if (event.shiftKey) {
    if (!state.drag.axisLock) {
      const dx = (event.clientX - state.drag.startX) / state.view.scale;
      const dy = (event.clientY - state.drag.startY) / state.view.scale;
      state.drag.axisLock = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      state.drag.originX = mod.x;
      state.drag.originY = mod.y;
      state.drag.startX = event.clientX;
      state.drag.startY = event.clientY;
    }
  } else if (state.drag.axisLock) {
    state.drag.axisLock = null;
    state.drag.originX = mod.x;
    state.drag.originY = mod.y;
    state.drag.startX = event.clientX;
    state.drag.startY = event.clientY;
  }

  const dx = (event.clientX - state.drag.startX) / state.view.scale;
  const dy = (event.clientY - state.drag.startY) / state.view.scale;
  if (state.drag.axisLock === "x") {
    mod.x = Math.round(state.drag.originX + dx);
    mod.y = Math.round(state.drag.originY);
  } else if (state.drag.axisLock === "y") {
    mod.x = Math.round(state.drag.originX);
    mod.y = Math.round(state.drag.originY + dy);
  } else {
    mod.x = Math.round(state.drag.originX + dx);
    mod.y = Math.round(state.drag.originY + dy);
  }
  const el = moduleElements.get(mod.id);
  if (el) {
    el.style.left = `${mod.x}px`;
    el.style.top = `${mod.y}px`;
  }
  scheduleUpdateWires();
}

/**
 * 结束模块拖拽
 */
function endModuleDrag() {
  state.drag = null;
  window.removeEventListener("pointermove", onModuleDragHandler);
  window.removeEventListener("pointerup", endModuleDragHandler);
  doUpdateWires();
  doRenderProperties();
  recordHistory();
  scheduleAutoSave();
}

/**
 * 开始平移
 */
function startPan(event) {
  state.pan = {
    startX: event.clientX,
    startY: event.clientY,
    originX: state.view.offsetX,
    originY: state.view.offsetY,
  };

  onPanHandler = onPan;
  endPanHandler = endPan;

  window.addEventListener("pointermove", onPanHandler);
  window.addEventListener("pointerup", endPanHandler);
}

/**
 * 平移中
 */
function onPan(event) {
  if (!state.pan) {
    return;
  }
  state.view.offsetX = state.pan.originX + (event.clientX - state.pan.startX);
  state.view.offsetY = state.pan.originY + (event.clientY - state.pan.startY);
  applyViewTransform();
}

/**
 * 结束平移
 */
function endPan() {
  state.pan = null;
  window.removeEventListener("pointermove", onPanHandler);
  window.removeEventListener("pointerup", endPanHandler);
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
  };

  onWireDragHandler = onWireDrag;
  endWireDragHandler = endWireDrag;

  window.addEventListener("pointermove", onWireDragHandler);
  window.addEventListener("pointerup", endWireDragHandler);
}

/**
 * 连线拖拽中
 */
function onWireDrag(event) {
  if (!state.dragWire) {
    return;
  }
  const wire = state.wires.find((item) => item.id === state.dragWire.id);
  if (!wire) {
    return;
  }

  const dx = (event.clientX - state.dragWire.startX) / state.view.scale;
  const dy = (event.clientY - state.dragWire.startY) / state.view.scale;

  if (state.dragWire.segmentIndex !== undefined && Array.isArray(wire.bends)) {
    // 智能路由线段拖拽：移动线段保持直角
    // 线段 segmentIndex 连接 points[segmentIndex] 和 points[segmentIndex + 1]
    // points = [start, ...bends, end]，共有 bends.length + 2 个点
    // 因此线段 0 是 start -> bends[0]
    // 线段 1 是 bends[0] -> bends[1]
    // 线段 n 是 bends[n-1] -> end
    const segIdx = state.dragWire.segmentIndex;
    const isHorizontal = state.dragWire.isHorizontal;
    const origins = state.dragWire.origin;
    const numBends = wire.bends.length;

    // 水平线段只能垂直移动（改变 y 值），垂直线段只能水平移动（改变 x 值）
    if (isHorizontal) {
      // 水平线段：移动时改变相关点的 y 坐标
      // 线段 segIdx 的两个端点：
      // - 如果 segIdx == 0：端点是 start 和 bends[0]，只能移动 bends[0] 的 y
      // - 如果 segIdx == numBends：端点是 bends[numBends-1] 和 end，只能移动 bends[numBends-1] 的 y
      // - 否则：端点是 bends[segIdx-1] 和 bends[segIdx]，移动两个点的 y
      if (segIdx === 0) {
        // 第一段：只影响 bends[0]
        wire.bends[0] = {
          x: origins[0].x,
          y: Math.round(origins[0].y + dy),
        };
      } else if (segIdx === numBends) {
        // 最后一段：只影响 bends[numBends-1]
        wire.bends[numBends - 1] = {
          x: origins[numBends - 1].x,
          y: Math.round(origins[numBends - 1].y + dy),
        };
      } else {
        // 中间段：影响 bends[segIdx-1] 和 bends[segIdx]
        wire.bends[segIdx - 1] = {
          x: origins[segIdx - 1].x,
          y: Math.round(origins[segIdx - 1].y + dy),
        };
        wire.bends[segIdx] = {
          x: origins[segIdx].x,
          y: Math.round(origins[segIdx].y + dy),
        };
      }
    } else {
      // 垂直线段：移动时改变相关点的 x 坐标
      if (segIdx === 0) {
        // 第一段：只影响 bends[0]
        wire.bends[0] = {
          x: Math.round(origins[0].x + dx),
          y: origins[0].y,
        };
      } else if (segIdx === numBends) {
        // 最后一段：只影响 bends[numBends-1]
        wire.bends[numBends - 1] = {
          x: Math.round(origins[numBends - 1].x + dx),
          y: origins[numBends - 1].y,
        };
      } else {
        // 中间段：影响 bends[segIdx-1] 和 bends[segIdx]
        wire.bends[segIdx - 1] = {
          x: Math.round(origins[segIdx - 1].x + dx),
          y: origins[segIdx - 1].y,
        };
        wire.bends[segIdx] = {
          x: Math.round(origins[segIdx].x + dx),
          y: origins[segIdx].y,
        };
      }
    }
  } else if (state.dragWire.bendIndex >= 0 && Array.isArray(wire.bends)) {
    const origin = state.dragWire.origin;
    wire.bends[state.dragWire.bendIndex] = {
      x: Math.round(origin.x + dx),
      y: Math.round(origin.y + dy),
    };
  } else {
    if (state.dragWire.route === "V") {
      wire.bend = Math.round(state.dragWire.origin + dy);
    } else {
      wire.bend = Math.round(state.dragWire.origin + dx);
    }
  }
  scheduleUpdateWires();
}

/**
 * 结束连线拖拽
 */
function endWireDrag() {
  state.dragWire = null;
  window.removeEventListener("pointermove", onWireDragHandler);
  window.removeEventListener("pointerup", endWireDragHandler);
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
      event.dataTransfer.setData(MODULE_DRAG_MIME, item.dataset.type);
      event.dataTransfer.effectAllowed = "copy";
    });
    item.addEventListener("click", () => {
      const type = item.dataset.type;
      const library = MODULE_LIBRARY[type] || MODULE_LIBRARY.seq;
      const rect = canvas.getBoundingClientRect();
      const x = rect.width / 2 - library.width / 2;
      const y = rect.height / 2 - library.height / 2;
      createModule(type, x, y, select);
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
    const type = event.dataTransfer.getData(MODULE_DRAG_MIME);
    if (!type) {
      return;
    }
    event.preventDefault();
    const library = MODULE_LIBRARY[type] || MODULE_LIBRARY.seq;
    const point = getCanvasPoint(event);
    createModule(type, point.x - library.width / 2, point.y - library.height / 2, select);
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
  const modalClose = document.getElementById("modal-close");
  const modalApply = document.getElementById("modal-apply");
  const importModuleButton = document.getElementById("btn-import-module");
  const exportPngButton = document.getElementById("btn-export-png");
  const exportSvgButton = document.getElementById("btn-export-svg");
  const bgToggleButton = document.getElementById("btn-bg-toggle");
  const demoEscutervButton = document.getElementById("btn-demo-escuterv");
  const demoLfsrButton = document.getElementById("btn-demo-lfsr");
  let modalMode = "export";

  const diagramCallbacks = {
    renderModules: doRenderModules,
    updateWires: doUpdateWires,
    renderProperties: doRenderProperties,
    updateStatus: updateStatus,
  };

  const openModal = (mode) => {
    modalMode = mode;
    modalText.placeholder = "";
    if (mode === "export") {
      modalTitle.textContent = "Export JSON";
      modalText.value = JSON.stringify(serializeState(), null, 2);
      modalText.readOnly = true;
      modalApply.style.display = "none";
    } else if (mode === "import-module") {
      modalTitle.textContent = "Import Module JSON";
      modalText.value = "";
      modalText.readOnly = false;
      modalText.placeholder = "Paste a module JSON object here";
      modalApply.style.display = "inline-flex";
    } else {
      modalTitle.textContent = "Import JSON";
      modalText.value = "";
      modalText.readOnly = false;
      modalText.placeholder = "Paste diagram JSON here";
      modalApply.style.display = "inline-flex";
    }
    modal.classList.remove("hidden");
  };

  const closeModal = () => {
    modal.classList.add("hidden");
  };

  const loadDemo = async (path) => {
    try {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch demo: ${path}`);
      }
      const data = await response.json();
      if (!loadState(data, diagramCallbacks)) {
        throw new Error(`Invalid demo data: ${path}`);
      }
      recordHistory();
      scheduleAutoSave();
    } catch (err) {
      alert("Failed to load demo.");
    }
  };

  document.getElementById("btn-export").addEventListener("click", () => openModal("export"));
  document.getElementById("btn-import").addEventListener("click", () => openModal("import"));
  if (importModuleButton) {
    importModuleButton.addEventListener("click", () => openModal("import-module"));
  }

  modalClose.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });

  modalApply.addEventListener("click", () => {
    if (modalMode === "import") {
      try {
        const data = JSON.parse(modalText.value);
        if (!loadState(data, diagramCallbacks)) {
          return;
        }
        recordHistory();
        scheduleAutoSave();
        closeModal();
      } catch (err) {
        alert("Failed to parse JSON.");
      }
      return;
    }
    if (modalMode === "import-module") {
      if (addModulesFromJson(modalText.value)) {
        closeModal();
      }
    }
  });

  document.getElementById("btn-save").addEventListener("click", () => {
    saveDiagramToStorage();
  });

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
    state.modules = [];
    state.wires = [];
    state.selection = null;
    state.connecting = null;
    doRenderModules();
    doUpdateWires();
    doRenderProperties();
    updateStatus();
    recordHistory();
    clearDiagramStorage();
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
  canvas.addEventListener("pointerdown", (event) => {
    if (event.ctrlKey && event.button === 1) {
      event.preventDefault();
      startPan(event);
      return;
    }
    if (event.target.closest(".module") || event.target.closest(".wire-hit")) {
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
    state.connecting.cursor = getCanvasPoint(event);
    scheduleUpdateWires();
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const cursorX = event.clientX - rect.left;
        const cursorY = event.clientY - rect.top;
        const oldScale = state.view.scale;
        const factor = event.deltaY > 0 ? 0.9 : 1.1;
        const nextScale = clamp(oldScale * factor, 0.2, 2);
        if (nextScale === oldScale) {
          return;
        }
        const worldX = (cursorX - state.view.offsetX) / oldScale;
        const worldY = (cursorY - state.view.offsetY) / oldScale;
        state.view.scale = nextScale;
        state.view.offsetX = cursorX - worldX * nextScale;
        state.view.offsetY = cursorY - worldY * nextScale;
        applyViewTransform();
        updateStatus();
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
    if (isTypingTarget(document.activeElement)) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      const handled = event.shiftKey ? redoHistory(historyCallbacks) : undoHistory(historyCallbacks);
      if (handled) {
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
    if (event.key === "Delete" || event.key === "Backspace") {
      deleteSelected();
    }
    if (event.key === "Escape") {
      state.connecting = null;
      doUpdateWires();
      updateStatus();
    }
  });
}

/**
 * 初始化窗口事件
 */
export function initWindowEvents() {
  window.addEventListener("resize", () => {
    syncSvgSize();
    scheduleUpdateWires();
  });
}

/**
 * 初始化状态栏点击
 */
export function initStatusClick() {
  statusEl.addEventListener("click", () => {
    resetView();
  });
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
