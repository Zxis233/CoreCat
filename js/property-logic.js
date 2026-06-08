/**
 * Property logic - state mutations used by the properties panel without DOM work.
 */

import { MODULE_LIBRARY, DEFAULT_MODULE, MUX_DEFAULT } from './constants.js';
import { uid, clamp, ensureMuxGeometry } from './utils.js';
import { ensureMuxPorts } from './module.js';
import { setWireDefaultBend, setWireSmartBends } from './wire.js';

export function getPortSideOptions(mod, port) {
  const isClockPort = mod.type === "reg" && (port.clock === true || port.name === "CLK");
  if (isClockPort) {
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
  mod.type = value;
  if (value === "mux") {
    mod.muxInputs = MUX_DEFAULT.inputs;
    mod.muxControlSide = MUX_DEFAULT.controlSide;
    mod.ports = [];
    ensureMuxPorts(mod);
  }
}

export function setMuxInputs(mod, value) {
  mod.muxInputs = clamp(Math.round(value), 2, 8);
  ensureMuxPorts(mod);
}

export function setMuxControlSide(mod, value) {
  mod.muxControlSide = value;
  ensureMuxPorts(mod);
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
  return wires.filter((wire) => wire.from.portId !== portId && wire.to.portId !== portId);
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
