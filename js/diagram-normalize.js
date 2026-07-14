/**
 * Diagram normalization - JSON import cleanup and validation.
 */

import {
  MODULE_LIBRARY,
  DEFAULT_MODULE,
  DEFAULT_WIRE,
  WIRE_STYLES,
  MUX_DEFAULT,
  DEFAULT_PORT_LABEL_SIZE,
  PORT_LABEL_SIZE_RANGE,
  DEFAULT_WIRE_SNAP_MODE,
  WIRE_SNAP_MODES,
  DIAGRAM_LIMITS
} from './constants.js';
import { sanitizeSvgPaint, uid } from './utils.js';
import { isKnownModuleType } from './module.js';

export const DIAGRAM_SCHEMA_VERSION = 1;

const NORMALIZE_LIMITS = {
  ...DIAGRAM_LIMITS,
  idLength: 128,
  colorLength: 128,
  coordinate: 100000,
  moduleSize: 5000,
  strokeWidth: 32,
  wireWidth: 32,
  nameSize: 96,
};

const PORT_SIDES = new Set(["left", "right", "top", "bottom"]);
const MUX_PORT_SIDES = new Set(["left", "right", "top", "bottom", "slopeTop", "slopeBottom"]);

function addNormalizeWarning(warnings, message) {
  if (warnings.length < 25) {
    warnings.push(message);
  }
}

function normalizeString(value, fallback = "", maxLength = NORMALIZE_LIMITS.textLength) {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.slice(0, maxLength);
}

function normalizeWireSnapMode(value) {
  return Object.values(WIRE_SNAP_MODES).includes(value) ? value : DEFAULT_WIRE_SNAP_MODE;
}

function normalizeNumber(value, fallback, min, max, round = false) {
  const raw = Number.isFinite(value) ? value : fallback;
  const clamped = Math.min(max, Math.max(min, raw));
  return round ? Math.round(clamped) : clamped;
}

function normalizeId(value, prefix, usedIds, warnings, context) {
  let id = typeof value === "string" ? value.trim().slice(0, NORMALIZE_LIMITS.idLength) : "";
  if (!id || usedIds.has(id)) {
    const original = id || "(empty)";
    do {
      id = uid(prefix);
    } while (usedIds.has(id));
    addNormalizeWarning(warnings, `${context} id ${original} was replaced with ${id}.`);
  }
  usedIds.add(id);
  return id;
}

function normalizePortSide(value, fallback, moduleType, warnings, context) {
  const allowedSides = moduleType === "mux" ? MUX_PORT_SIDES : PORT_SIDES;
  const side = typeof value === "string" ? value : fallback;
  if (allowedSides.has(side)) {
    return side;
  }
  if (allowedSides.has(fallback)) {
    addNormalizeWarning(warnings, `${context} port side was reset to ${fallback}.`);
    return fallback;
  }
  addNormalizeWarning(warnings, `${context} port side was reset to left.`);
  return "left";
}

function normalizePorts(rawPorts, libraryPorts, moduleType, moduleId, warnings) {
  const source = Array.isArray(rawPorts)
    ? rawPorts
    : (Array.isArray(libraryPorts) ? libraryPorts : []);
  const usedPortIds = new Set();
  const ports = [];

  if (source.length > NORMALIZE_LIMITS.portsPerModule) {
    addNormalizeWarning(warnings, `${moduleId} has too many ports; extra ports were ignored.`);
  }

  source.slice(0, NORMALIZE_LIMITS.portsPerModule).forEach((rawPort, index) => {
    if (!rawPort || typeof rawPort !== "object") {
      addNormalizeWarning(warnings, `${moduleId} port ${index + 1} was ignored because it is not an object.`);
      return;
    }

    const fallbackName = `P${index + 1}`;
    if (typeof rawPort.name === "string" && rawPort.name.length > NORMALIZE_LIMITS.textLength) {
      addNormalizeWarning(warnings, `${moduleId} port ${index + 1} name was truncated.`);
    }
    const name = normalizeString(rawPort.name, fallbackName);
    const isClock = rawPort.clock === true || String(name).toUpperCase() === "CLK";
    let side = normalizePortSide(rawPort.side, "left", moduleType, warnings, `${moduleId}:${name}`);
    if ((moduleType === "reg" || moduleType === "seq") && isClock && side !== "top" && side !== "bottom") {
      side = "bottom";
      addNormalizeWarning(warnings, `${moduleId}:${name} clock port was moved to bottom.`);
    }

    const port = {
      id: normalizeId(rawPort.id, "port", usedPortIds, warnings, `${moduleId}:${name}`),
      name,
      side,
      offset: normalizeNumber(rawPort.offset, 0.5, 0, 1),
    };
    if (rawPort.clock === true) {
      port.clock = true;
    }
    ports.push(port);
  });

  return ports;
}

function normalizeModule(rawModule, index, usedModuleIds, warnings) {
  if (!rawModule || typeof rawModule !== "object") {
    addNormalizeWarning(warnings, `Module ${index + 1} was ignored because it is not an object.`);
    return null;
  }

  const rawType = typeof rawModule.type === "string" ? rawModule.type : "seq";
  const type = isKnownModuleType(rawType) ? rawType : "seq";
  if (type !== rawType) {
    addNormalizeWarning(warnings, `Module ${index + 1} has unknown type ${rawType}; seq was used.`);
  }
  const library = MODULE_LIBRARY[type];
  const id = normalizeId(rawModule.id, "mod", usedModuleIds, warnings, `Module ${index + 1}`);
  if (typeof rawModule.name === "string" && rawModule.name.length > NORMALIZE_LIMITS.textLength) {
    addNormalizeWarning(warnings, `Module ${index + 1} name was truncated.`);
  }

  const moduleItem = {
    id,
    type,
    name: normalizeString(rawModule.name, library.label),
    x: normalizeNumber(rawModule.x, 0, -NORMALIZE_LIMITS.coordinate, NORMALIZE_LIMITS.coordinate, true),
    y: normalizeNumber(rawModule.y, 0, -NORMALIZE_LIMITS.coordinate, NORMALIZE_LIMITS.coordinate, true),
    width: normalizeNumber(rawModule.width, library.width, 1, NORMALIZE_LIMITS.moduleSize, true),
    height: normalizeNumber(rawModule.height, library.height, 1, NORMALIZE_LIMITS.moduleSize, true),
    nameSize: normalizeNumber(rawModule.nameSize, DEFAULT_MODULE.nameSize, 1, NORMALIZE_LIMITS.nameSize),
    showType: rawModule.showType === undefined ? DEFAULT_MODULE.showType : Boolean(rawModule.showType),
    fill: sanitizeSvgPaint(normalizeString(rawModule.fill, DEFAULT_MODULE.fill, NORMALIZE_LIMITS.colorLength), DEFAULT_MODULE.fill),
    strokeColor: sanitizeSvgPaint(normalizeString(rawModule.strokeColor, DEFAULT_MODULE.strokeColor, NORMALIZE_LIMITS.colorLength), DEFAULT_MODULE.strokeColor),
    strokeWidth: normalizeNumber(rawModule.strokeWidth, DEFAULT_MODULE.strokeWidth, 0, NORMALIZE_LIMITS.strokeWidth),
    ports: normalizePorts(rawModule.ports, library.ports, type, id, warnings),
  };

  if (type === "mux") {
    moduleItem.muxInputs = normalizeNumber(rawModule.muxInputs, MUX_DEFAULT.inputs, 2, 8, true);
    moduleItem.muxControlSide = rawModule.muxControlSide === "bottom" ? "bottom" : MUX_DEFAULT.controlSide;
  }

  return moduleItem;
}

function normalizeWireRef(ref, modulePortsById) {
  if (!ref || typeof ref !== "object") {
    return null;
  }
  const moduleId = typeof ref.moduleId === "string" ? ref.moduleId.trim() : "";
  const portId = typeof ref.portId === "string" ? ref.portId.trim() : "";
  const portIds = modulePortsById.get(moduleId);
  if (!portIds || !portIds.has(portId)) {
    return null;
  }
  return { moduleId, portId };
}

function normalizeWireBends(rawBends, warnings, wireId) {
  if (!Array.isArray(rawBends)) {
    return null;
  }
  const bends = [];
  if (rawBends.length > NORMALIZE_LIMITS.bendsPerWire) {
    addNormalizeWarning(warnings, `${wireId} has too many bend points; extra points were ignored.`);
  }
  rawBends.slice(0, NORMALIZE_LIMITS.bendsPerWire).forEach((rawBend, index) => {
    if (!rawBend || typeof rawBend !== "object" || !Number.isFinite(rawBend.x) || !Number.isFinite(rawBend.y)) {
      addNormalizeWarning(warnings, `${wireId} bend ${index + 1} was ignored because it is invalid.`);
      return;
    }
    bends.push({
      x: normalizeNumber(rawBend.x, 0, -NORMALIZE_LIMITS.coordinate, NORMALIZE_LIMITS.coordinate, true),
      y: normalizeNumber(rawBend.y, 0, -NORMALIZE_LIMITS.coordinate, NORMALIZE_LIMITS.coordinate, true),
    });
  });
  return bends.length > 0 ? bends : null;
}

function normalizeWire(rawWire, index, usedWireIds, modulePortsById, warnings) {
  if (!rawWire || typeof rawWire !== "object") {
    addNormalizeWarning(warnings, `Wire ${index + 1} was ignored because it is not an object.`);
    return null;
  }

  const id = normalizeId(rawWire.id, "wire", usedWireIds, warnings, `Wire ${index + 1}`);
  const from = normalizeWireRef(rawWire.from, modulePortsById);
  const to = normalizeWireRef(rawWire.to, modulePortsById);
  if (!from || !to) {
    addNormalizeWarning(warnings, `${id} was ignored because it references a missing module or port.`);
    return null;
  }
  if (typeof rawWire.label === "string" && rawWire.label.length > NORMALIZE_LIMITS.textLength) {
    addNormalizeWarning(warnings, `${id} label was truncated.`);
  }

  return {
    id,
    from,
    to,
    label: normalizeString(rawWire.label, ""),
    labelAt: rawWire.labelAt === "start" ? "start" : "end",
    route: rawWire.route === "V" ? "V" : "H",
    bend: normalizeNumber(rawWire.bend, 0, -NORMALIZE_LIMITS.coordinate, NORMALIZE_LIMITS.coordinate, true),
    bends: normalizeWireBends(rawWire.bends, warnings, id),
    color: sanitizeSvgPaint(normalizeString(rawWire.color, DEFAULT_WIRE.color, NORMALIZE_LIMITS.colorLength), DEFAULT_WIRE.color),
    width: normalizeNumber(rawWire.width, DEFAULT_WIRE.width, 0.5, NORMALIZE_LIMITS.wireWidth),
    style: WIRE_STYLES[rawWire.style] !== undefined ? rawWire.style : DEFAULT_WIRE.style,
  };
}

function buildModulePortIndex(modules) {
  const modulePortsById = new Map();
  modules.forEach((mod) => {
    modulePortsById.set(mod.id, new Set(mod.ports.map((port) => port.id)));
  });
  return modulePortsById;
}

export function countModuleTypes(modules) {
  const counts = {};
  modules.forEach((mod) => {
    counts[mod.type] = (counts[mod.type] || 0) + 1;
  });
  return counts;
}

export function normalizeDiagram(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== "object") {
    errors.push("Invalid diagram data.");
    return { ok: false, diagram: null, errors, warnings };
  }

  const hasSchemaVersion = Object.prototype.hasOwnProperty.call(data, "schemaVersion");
  const schemaVersion = hasSchemaVersion ? data.schemaVersion : 0;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
    errors.push("Invalid diagram schemaVersion.");
    return { ok: false, diagram: null, errors, warnings };
  }
  if (schemaVersion > DIAGRAM_SCHEMA_VERSION) {
    errors.push(
      `Diagram schema version ${schemaVersion} is newer than supported version ${DIAGRAM_SCHEMA_VERSION}.`
    );
    return { ok: false, diagram: null, errors, warnings };
  }
  if (schemaVersion !== 0 && schemaVersion !== DIAGRAM_SCHEMA_VERSION) {
    errors.push(`Unsupported diagram schema version ${schemaVersion}.`);
    return { ok: false, diagram: null, errors, warnings };
  }
  if (!Array.isArray(data.modules) || !Array.isArray(data.wires)) {
    errors.push("Invalid diagram data: modules and wires must be arrays.");
    return { ok: false, diagram: null, errors, warnings };
  }

  if (data.modules.length > NORMALIZE_LIMITS.modules) {
    errors.push(`Diagram exceeds the ${NORMALIZE_LIMITS.modules} module limit.`);
  }
  if (data.wires.length > NORMALIZE_LIMITS.wires) {
    errors.push(`Diagram exceeds the ${NORMALIZE_LIMITS.wires} wire limit.`);
  }
  if (data.modules.some((mod) => mod && Array.isArray(mod.ports) && mod.ports.length > NORMALIZE_LIMITS.portsPerModule)) {
    errors.push(`A module exceeds the ${NORMALIZE_LIMITS.portsPerModule} port limit.`);
  }
  if (data.wires.some((wire) => wire && Array.isArray(wire.bends) && wire.bends.length > NORMALIZE_LIMITS.bendsPerWire)) {
    errors.push(`A wire exceeds the ${NORMALIZE_LIMITS.bendsPerWire} bend-point limit.`);
  }
  if (errors.length > 0) {
    return { ok: false, diagram: null, errors, warnings };
  }

  const usedModuleIds = new Set();
  const modules = data.modules
    .slice(0, NORMALIZE_LIMITS.modules)
    .map((mod, index) => normalizeModule(mod, index, usedModuleIds, warnings))
    .filter(Boolean);
  const modulePortsById = buildModulePortIndex(modules);
  const usedWireIds = new Set();
  const wires = data.wires
    .slice(0, NORMALIZE_LIMITS.wires)
    .map((wire, index) => normalizeWire(wire, index, usedWireIds, modulePortsById, warnings))
    .filter(Boolean);

  return {
    ok: true,
    diagram: {
      schemaVersion: DIAGRAM_SCHEMA_VERSION,
      canvasBackground: sanitizeSvgPaint(normalizeString(data.canvasBackground, "", NORMALIZE_LIMITS.colorLength), ""),
      portLabelSize: normalizeNumber(
        data.portLabelSize,
        DEFAULT_PORT_LABEL_SIZE,
        PORT_LABEL_SIZE_RANGE.min,
        PORT_LABEL_SIZE_RANGE.max,
        true
      ),
      wireSnapMode: normalizeWireSnapMode(data.wireSnapMode),
      modules,
      wires,
    },
    errors,
    warnings,
  };
}

export function normalizeModuleImports(data, existingModuleIds = new Set()) {
  const warnings = [];
  const source = Array.isArray(data)
    ? data
    : (data && typeof data === "object" && Array.isArray(data.modules))
      ? data.modules
      : [data];

  if (source.length > NORMALIZE_LIMITS.modules) {
    addNormalizeWarning(warnings, "Module import has too many modules; extra modules were ignored.");
  }

  const usedModuleIds = new Set(existingModuleIds);
  const modules = source
    .slice(0, NORMALIZE_LIMITS.modules)
    .map((moduleData, index) => {
      const shouldUseLibraryPorts =
        moduleData &&
        typeof moduleData === "object" &&
        Array.isArray(moduleData.ports) &&
        moduleData.ports.length === 0;
      const importData = shouldUseLibraryPorts ? { ...moduleData, ports: undefined } : moduleData;
      return normalizeModule(importData, index, usedModuleIds, warnings);
    })
    .filter(Boolean);

  return { modules, warnings };
}
