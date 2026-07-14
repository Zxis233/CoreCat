/**
 * Property logic - state mutations used by the properties panel without DOM work.
 */

import { MODULE_LIBRARY, DEFAULT_MODULE, MUX_DEFAULT, DIAGRAM_LIMITS } from './constants.js';
import { state } from './state.js';
import { uid, clamp, ensureMuxGeometry, isClockPort } from './utils.js';
import { ensureMuxPorts } from './module.js';
import { setWireDefaultBend, setWireSmartBends } from './wire.js';

export function getPortSideOptions(mod, port) {
  if (isClockPort(mod, port)) {
    return [
      { value: "top", label: "Top" },
      { value: "bottom", label: "Bottom" },
    ];
  }
  return [
    { value: "left", label: "Left" },
    { value: "right", label: "Right" },
    { value: "top", label: "Top" },
    { value: "bottom", label: "Bottom" },
  ];
}

export function resetModuleStyle(mod) {
  mod.fill = DEFAULT_MODULE.fill;
  mod.strokeColor = DEFAULT_MODULE.strokeColor;
  mod.strokeWidth = DEFAULT_MODULE.strokeWidth;
}

export function setModuleType(mod, value) {
  if (!mod || !Object.prototype.hasOwnProperty.call(MODULE_LIBRARY, value)) {
    return null;
  }

  const previousType = mod.type;
  mod.type = value;
  if (value === "mux") {
    mod.muxInputs = MUX_DEFAULT.inputs;
    mod.muxControlSide = MUX_DEFAULT.controlSide;
    return ensureMuxPorts(mod) ? mod : null;
  }

  if (previousType === "mux") {
    delete mod.muxInputs;
    delete mod.muxControlSide;
  }

  const ports = Array.isArray(mod.ports) ? mod.ports : [];
  ports.forEach((port) => {
    if (port.side === "slopeTop") {
      port.side = "top";
    } else if (port.side === "slopeBottom") {
      port.side = "bottom";
    }
    if (isClockPort(mod, port) && port.side !== "top" && port.side !== "bottom") {
      port.side = "bottom";
    }
  });
  mod.ports = ports.slice(0, DIAGRAM_LIMITS.portsPerModule);

  const allowedPortIds = new Set(mod.ports.map((port) => port.id));
  state.wires = state.wires.filter((wire) => {
    if (wire.from.moduleId === mod.id && !allowedPortIds.has(wire.from.portId)) {
      return false;
    }
    if (wire.to.moduleId === mod.id && !allowedPortIds.has(wire.to.portId)) {
      return false;
    }
    return true;
  });
  return mod;
}

export function setMuxInputs(mod, value) {
  mod.muxInputs = clamp(Math.round(value), 2, 8);
  return ensureMuxPorts(mod);
}

export function setMuxControlSide(mod, value) {
  mod.muxControlSide = value;
  return ensureMuxPorts(mod);
}

export function setModuleWidth(mod, value) {
  const beforeHeight = mod.height;
  mod.width = clamp(Math.round(value), 40, 1000);
  if (mod.type === "mux") {
    ensureMuxGeometry(mod, "keepWidth");
  }
  return { heightChanged: mod.height !== beforeHeight };
}

export function setModuleHeight(mod, value) {
  const beforeWidth = mod.width;
  const beforeHeight = mod.height;
  mod.height = clamp(Math.round(value), 60, 1200);
  if (mod.type === "mux") {
    ensureMuxGeometry(mod, "keepHeight");
  }
  return {
    widthChanged: mod.width !== beforeWidth,
    heightChanged: mod.height !== beforeHeight,
  };
}

export function addPort(mod, createId = uid) {
  if (!mod || !Array.isArray(mod.ports) || mod.ports.length >= DIAGRAM_LIMITS.portsPerModule) {
    return null;
  }
  const port = {
    id: createId("port"),
    name: `P${mod.ports.length + 1}`,
    side: "left",
    offset: 0.5,
  };
  mod.ports.push(port);
  return port;
}

export function removePort(mod, wires, portId) {
  mod.ports = mod.ports.filter((item) => item.id !== portId);
  return wires.filter((wire) => {
    const leavesRemovedPort = wire.from.moduleId === mod.id && wire.from.portId === portId;
    const entersRemovedPort = wire.to.moduleId === mod.id && wire.to.portId === portId;
    return !leavesRemovedPort && !entersRemovedPort;
  });
}

export function deleteModule(modules, wires, moduleId) {
  return {
    modules: modules.filter((item) => item.id !== moduleId),
    wires: wires.filter((wire) => wire.from.moduleId !== moduleId && wire.to.moduleId !== moduleId),
  };
}

export function deleteWire(wires, wireId) {
  return wires.filter((item) => item.id !== wireId);
}

export function setWireRoute(wire, value) {
  wire.route = value;
  setWireDefaultBend(wire);
  wire.bends = null;
}

export function resetWireToSimpleRoute(wire) {
  wire.bends = null;
  setWireDefaultBend(wire);
}

export function recomputeWireSmartRoute(wire) {
  wire.bends = null;
  setWireDefaultBend(wire);
  setWireSmartBends(wire);
}

export function getModuleTypeOptions() {
  return Object.keys(MODULE_LIBRARY).map((key) => ({ value: key, label: MODULE_LIBRARY[key].label }));
}
