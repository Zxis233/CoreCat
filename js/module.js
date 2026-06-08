/**
 * Module - 模块相关功能
 * 包含模块创建、渲染、端口管理等
 */

import { state, moduleLayer, moduleElements } from './state.js';
import { MODULE_LIBRARY, DEFAULT_MODULE, MUX_DEFAULT } from './constants.js';
import { uid, isClockPort, ensureMuxGeometry, buildMuxSvgBackground, buildExtenderSvgBackground } from './utils.js';
import { getPortLocalPosition } from './port.js';

// 模块层事件委托处理器引用
let moduleLayerDelegatedHandler = null;

export function isKnownModuleType(type) {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(MODULE_LIBRARY, type);
}

export function resolveModuleType(type) {
  return isKnownModuleType(type) ? type : "seq";
}

/**
 * 应用模块外观样式
 */
export function applyModuleAppearance(el, mod) {
  if (mod.fill) {
    el.style.setProperty("--module-fill", mod.fill);
  }
  if (mod.strokeColor) {
    el.style.setProperty("--module-stroke", mod.strokeColor);
  }
  if (Number.isFinite(mod.strokeWidth)) {
    el.style.setProperty("--module-stroke-width", `${mod.strokeWidth}px`);
  }
}

/**
 * 确保MUX端口配置正确
 */
export function ensureMuxPorts(mod) {
  const inputs = Math.round(mod.muxInputs || MUX_DEFAULT.inputs);
  const clampedInputs = Math.max(2, Math.min(8, inputs));
  const controlSide = mod.muxControlSide === "bottom" ? "bottom" : MUX_DEFAULT.controlSide;
  mod.muxInputs = clampedInputs;
  mod.muxControlSide = controlSide;

  const existingByName = new Map();
  mod.ports.forEach((port) => existingByName.set(port.name, port));

  const ports = [];
  for (let i = 0; i < clampedInputs; i += 1) {
    const name = `I${i + 1}`;
    const existing = existingByName.get(name);
    ports.push({
      id: existing ? existing.id : uid("port"),
      name,
      side: "left",
      offset: (i + 1) / (clampedInputs + 1),
    });
  }

  const selExisting = existingByName.get("Sel");
  ports.push({
    id: selExisting ? selExisting.id : uid("port"),
    name: "Sel",
    side: controlSide === "bottom" ? "slopeBottom" : "slopeTop",
    offset: controlSide === "bottom" ? MUX_DEFAULT.controlOffsetBottom : MUX_DEFAULT.controlOffsetTop,
  });

  const outExisting = existingByName.get("Out");
  ports.push({
    id: outExisting ? outExisting.id : uid("port"),
    name: "Out",
    side: "right",
    offset: 0.5,
  });

  const allowedIds = new Set(ports.map((port) => port.id));
  state.wires = state.wires.filter((wire) => {
    if (wire.from.moduleId === mod.id && !allowedIds.has(wire.from.portId)) {
      return false;
    }
    if (wire.to.moduleId === mod.id && !allowedIds.has(wire.to.portId)) {
      return false;
    }
    return true;
  });

  mod.ports = ports;
}

/**
 * 创建模块
 */
export function createModule(type, x, y, selectCallback) {
  const moduleType = resolveModuleType(type);
  const library = MODULE_LIBRARY[moduleType];
  const count = (state.typeCounts[moduleType] = (state.typeCounts[moduleType] || 0) + 1);
  const moduleItem = {
    id: uid("mod"),
    type: moduleType,
    name: `${library.label} ${count}`,
    x: Math.round(x),
    y: Math.round(y),
    width: library.width,
    height: library.height,
    nameSize: DEFAULT_MODULE.nameSize,
    showType: DEFAULT_MODULE.showType,
    ports: library.ports.map((port) => ({
      id: uid("port"),
      name: port.name,
      side: port.side,
      offset: port.offset,
      clock: port.clock === true,
    })),
  };
  if (moduleType === "mux") {
    moduleItem.name = ``;
    moduleItem.muxInputs = MUX_DEFAULT.inputs;
    moduleItem.muxControlSide = MUX_DEFAULT.controlSide;
    moduleItem.ports = [];
    ensureMuxPorts(moduleItem);
  }
  state.modules.push(moduleItem);
  if (selectCallback) {
    selectCallback({ type: "module", id: moduleItem.id });
  }
}

/**
 * 确保模块具有默认属性值
 */
function ensureModuleDefaults(mod) {
  if (!Number.isFinite(mod.nameSize)) {
    mod.nameSize = DEFAULT_MODULE.nameSize;
  }
  if (mod.showType === undefined) {
    mod.showType = DEFAULT_MODULE.showType;
  }
  if (mod.fill === undefined) {
    mod.fill = DEFAULT_MODULE.fill;
  }
  if (mod.strokeColor === undefined) {
    mod.strokeColor = DEFAULT_MODULE.strokeColor;
  }
  if (mod.strokeWidth === undefined) {
    mod.strokeWidth = DEFAULT_MODULE.strokeWidth;
  }
  if (mod.type === "mux") {
    if (!Number.isFinite(mod.muxInputs)) {
      mod.muxInputs = MUX_DEFAULT.inputs;
    }
    if (!mod.muxControlSide) {
      mod.muxControlSide = MUX_DEFAULT.controlSide;
    }
  }
}

/**
 * 创建单个模块的DOM元素
 */
function createModuleElement(mod) {
  const isSelected = state.selection && state.selection.type === "module" && state.selection.id === mod.id;
  const el = document.createElement("div");
  el.className = `module ${mod.type}${isSelected ? " selected" : ""}`;
  el.style.left = `${mod.x}px`;
  el.style.top = `${mod.y}px`;
  el.style.width = `${mod.width}px`;
  el.dataset.id = mod.id;

  ensureModuleDefaults(mod);

  if (mod.type === "mux") {
    ensureMuxGeometry(mod);
    el.style.background = buildMuxSvgBackground(mod);
    el.style.backgroundSize = '100% 100%';
  } else if (mod.type === "extender") {
    el.style.background = buildExtenderSvgBackground(mod);
    el.style.backgroundSize = '100% 100%';
  }

  // Set height after ensureModuleDefaults and ensureMuxGeometry which may modify mod.height
  el.style.height = `${mod.height}px`;
  applyModuleAppearance(el, mod);

  // Create module header
  const header = document.createElement("div");
  header.className = "module-header";
  const title = document.createElement("div");
  title.className = "module-title";
  title.textContent = mod.name;
  title.style.fontSize = `${mod.nameSize}px`;
  header.appendChild(title);

  if (mod.showType) {
    const type = document.createElement("div");
    type.className = "module-type";
    type.textContent = isKnownModuleType(mod.type) ? MODULE_LIBRARY[mod.type].label : mod.type;
    header.appendChild(type);
  }
  el.appendChild(header);

  // 创建端口
  mod.ports.forEach((port) => {
    const clockPort = isClockPort(mod, port);
    if (clockPort && port.side !== "top" && port.side !== "bottom") {
      port.side = "bottom";
    }
    const local = getPortLocalPosition(mod, port);
    const portEl = document.createElement("div");
    portEl.className = clockPort ? "port clock-port" : "port";
    portEl.style.left = `${local.x}px`;
    portEl.style.top = `${local.y}px`;
    portEl.dataset.portId = port.id;
    portEl.dataset.moduleId = mod.id;

    el.appendChild(portEl);

    if (clockPort) {
      const marker = document.createElement("div");
      marker.className = "clock-marker";
      marker.dataset.side = port.side;
      marker.style.left = `${local.x}px`;
      marker.style.top = `${local.y}px`;
      el.appendChild(marker);
    } else {
      const label = document.createElement("div");
      label.className = "port-label";
      label.dataset.side = port.side;
      label.style.left = `${local.x}px`;
      label.style.top = `${local.y}px`;
      label.textContent = port.name;
      el.appendChild(label);
    }
  });

  return el;
}

/**
 * 渲染所有模块
 * 使用DocumentFragment批量操作DOM以提高性能
 */
export function renderModules(selectCallback, startModuleDragCallback, handlePortClickCallback) {
  // 移除旧的事件监听器（如果存在）
  if (moduleLayerDelegatedHandler) {
    moduleLayer.removeEventListener("pointerdown", moduleLayerDelegatedHandler);
    moduleLayerDelegatedHandler = null;
  }

  moduleLayer.innerHTML = "";
  moduleElements.clear();

  // 使用DocumentFragment批量添加DOM元素
  const fragment = document.createDocumentFragment();

  state.modules.forEach((mod) => {
    const el = createModuleElement(mod);
    fragment.appendChild(el);
    moduleElements.set(mod.id, el);
  });

  // 一次性添加所有模块到DOM
  moduleLayer.appendChild(fragment);

  // 创建新的事件委托处理器
  moduleLayerDelegatedHandler = (event) => {
    if (event.button !== 0) {
      return;
    }

    const portEl = event.target.closest(".port");
    const moduleEl = event.target.closest(".module");

    if (portEl && moduleEl) {
      // 端口点击
      event.stopPropagation();
      const moduleId = portEl.dataset.moduleId;
      const portId = portEl.dataset.portId;
      const mod = state.modules.find((m) => m.id === moduleId);
      if (mod && handlePortClickCallback) {
        const port = mod.ports.find((p) => p.id === portId);
        if (port) {
          handlePortClickCallback(event, mod, port);
        }
      }
    } else if (moduleEl) {
      // 模块点击
      event.preventDefault();
      const moduleId = moduleEl.dataset.id;
      const mod = state.modules.find((m) => m.id === moduleId);
      if (mod) {
        if (selectCallback) {
          selectCallback({ type: "module", id: mod.id });
        }
        if (startModuleDragCallback) {
          startModuleDragCallback(event, mod);
        }
      }
    }
  };

  moduleLayer.addEventListener("pointerdown", moduleLayerDelegatedHandler);
}
