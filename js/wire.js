/**
 * Wire - 连线相关功能
 * 包含连线创建、路由、渲染等
 */

import { state, wireLayer, canvas } from './state.js';
import { DEFAULT_WIRE, WIRE_STYLES, DIAGRAM_LIMITS } from './constants.js';
import { uid, svgEl } from './utils.js';
import { buildModulePortIndex, describePortRef, getPortByRef, getPortPositionByRef } from './port.js';
import { isHorizontalPortSide, isVerticalPortSide } from './interaction-logic.js';
import { findSmartRoute, moveRouteSegment, repairRoute, routeMode, simplifyRoute, validateRoute } from './wire-routing.js';
import {
  BEND_MARKER_MIN_RADIUS,
  BEND_MARKER_OVERLAP_BOOST,
  buildWirePath,
  computeWireOverlapKeys,
  getOutgoingDirection,
  getWireBendPoints,
  getWireHandlePositions,
  getWirePathPoints,
  getWireSegments,
  pointKey,
  wireLabelPosition,
} from './wire-geometry.js';

export {
  BEND_MARKER_MIN_RADIUS,
  BEND_MARKER_OVERLAP_BOOST,
  buildWirePath,
  computeWireOverlapKeys,
  getOutgoingDirection,
  getWireBendPoints,
  getWireHandlePositions,
  getWirePathPoints,
  getWireSegments,
  pointKey,
  wireLabelPosition,
} from './wire-geometry.js';

const wireDomEntries = new Map();
let connectionPreviewElement = null;
let wireHandleLayer = null;

function applyWireLabelGeometry(label, labelPos) {
  if (!label || !labelPos) {
    return;
  }
  label.setAttribute("x", labelPos.x);
  label.setAttribute("y", labelPos.y);
  label.setAttribute("text-anchor", labelPos.anchor || "middle");
  label.setAttribute("dominant-baseline", labelPos.baseline || "central");
  if (labelPos.angle) {
    label.setAttribute("transform", `rotate(${labelPos.angle} ${labelPos.x} ${labelPos.y})`);
  } else {
    label.removeAttribute("transform");
  }
}

function buildConnectionPreviewPath(start, end, fromSide) {
  const isVerticalPreview = isVerticalPortSide(fromSide);
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  return isVerticalPreview
    ? `M ${start.x} ${start.y} L ${start.x} ${midY} L ${end.x} ${midY} L ${end.x} ${end.y}`
    : `M ${start.x} ${start.y} L ${midX} ${start.y} L ${midX} ${end.y} L ${end.x} ${end.y}`;
}

function describePortRefWithIndex(ref, portIndex) {
  const indexedRef = portIndex ? getPortByRef(ref, portIndex) : null;
  return indexedRef
    ? `${indexedRef.mod.name}:${indexedRef.port.name}`
    : describePortRef(ref);
}

function addSetMapValue(map, key, value) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  map.get(key).add(value);
}

export function collectWireRenderItems(wires = state.wires) {
  const renderItems = [];
  const bendPointMap = new Map();
  const renderItemMap = new Map();
  const portIndex = buildModulePortIndex();

  wires.forEach((wire) => {
    const start = getPortPositionByRef(wire.from, portIndex);
    const end = getPortPositionByRef(wire.to, portIndex);
    if (!start || !end) {
      return;
    }

    const bendPoints = getWireBendPoints(wire, start, end);
    bendPoints.forEach((point) => {
      addSetMapValue(bendPointMap, pointKey(point), wire.id);
    });

    const pathPoints = getWirePathPoints(wire, start, end);
    const segments = getWireSegments(pathPoints);
    const bendDirections = new Map();
    for (let i = 1; i < pathPoints.length - 1; i++) {
      const point = pathPoints[i];
      const dir = getOutgoingDirection(pathPoints, i);
      if (!dir) {
        continue;
      }
      addSetMapValue(bendDirections, pointKey(point), dir);
    }

    const item = { wire, start, end, bendPoints, segments, bendDirections };
    renderItems.push(item);
    renderItemMap.set(wire.id, item);
  });

  return { renderItems, bendPointMap, renderItemMap, portIndex };
}

/**
 * 设置连线默认弯折点
 */
export function setWireDefaultBend(wire) {
  const start = getPortPositionByRef(wire.from);
  const end = getPortPositionByRef(wire.to);
  if (!start || !end) {
    return;
  }
  if (wire.route === "V") {
    wire.bend = Math.round((start.y + end.y) / 2);
  } else {
    wire.bend = Math.round((start.x + end.x) / 2);
  }
  // Reset bends to null for simple routing (can be set later for multi-segment routes)
  wire.bends = null;
  wire.routingMode = 'simple';
  delete wire.routeWarning;
}

export function getWireRouteContext(wire, portIndex = buildModulePortIndex()) {
  const from = getPortByRef(wire.from, portIndex), to = getPortByRef(wire.to, portIndex);
  if (!from || !to) return null;
  return {
    start: getPortPositionByRef(wire.from, portIndex), end: getPortPositionByRef(wire.to, portIndex),
    fromSide: from.port.side, toSide: to.port.side, fromId: from.mod.id, toId: to.mod.id,
    modules: state.modules, width: wire.width,
  };
}

// Baselines are transient: restoring a document never triggers a new route search.
let routeBaselines = new WeakMap();
let routeScene = null;
function saveRouteScene() {
  routeScene = {
    modules: state.modules.map(mod => ({ mod, data: structuredClone(mod) })),
    wires: captureWireRoutes(),
  };
}
function terminalSignature(context) {
  return JSON.stringify([context.start, context.end, context.fromSide, context.toSide]);
}
export function rememberWireRoutes() {
  routeBaselines = new WeakMap();
  const index = buildModulePortIndex();
  for (const wire of state.wires) {
    const context = getWireRouteContext(wire, index);
    if (context) routeBaselines.set(wire, terminalSignature(context));
  }
  saveRouteScene();
}

export function captureWireRoutes() {
  return state.wires.map(wire => ({ wire, bend: wire.bend,
    bends: Array.isArray(wire.bends) ? wire.bends.map(p => ({ ...p })) : wire.bends,
    routingMode: wire.routingMode, routeWarning: wire.routeWarning,
    signature: routeBaselines.get(wire) }));
}

export function restoreWireRoutes(snapshot) {
  for (const saved of snapshot || []) {
    Object.assign(saved.wire, { bend: saved.bend,
      bends: Array.isArray(saved.bends) ? saved.bends.map(p => ({ ...p })) : saved.bends,
      routingMode: saved.routingMode, routeWarning: saved.routeWarning });
    if (saved.signature === undefined) routeBaselines.delete(saved.wire);
    else routeBaselines.set(saved.wire, saved.signature);
  }
}

/** Explicit Smart action: only replace the existing route after success. */
export function setWireSmartBends(wire, { remember = true } = {}) {
  const context = getWireRouteContext(wire);
  if (!context) return { ok: false, reason: 'A wire endpoint is missing.' };
  const result = findSmartRoute(context);
  if (result.ok) {
    wire.bends = result.points.slice(1, -1);
    wire.routingMode = 'auto';
    delete wire.routeWarning;
    routeBaselines.set(wire, terminalSignature(context));
    if (remember) saveRouteScene();
  } else wire.routeWarning = result.reason;
  return result;
}

/** Called by document mutations, never by rendering or undo/redo. */
export function maintainWireRoutes({ reroute = true, moduleId = null } = {}) {
  const index = buildModulePortIndex();
  for (const wire of state.wires) {
    const mode = routeMode(wire);
    if (mode === 'simple') continue;
    const context = getWireRouteContext(wire, index);
    if (!context) continue;
    const signature = terminalSignature(context);
    const changed = routeBaselines.get(wire) !== signature;
    if (moduleId && wire.from.moduleId !== moduleId && wire.to.moduleId !== moduleId && !reroute) continue;
    let points = getWirePathPoints(wire, context.start, context.end);
    if (changed) {
      points = repairRoute(points, context);
      if (points.length - 2 <= DIAGRAM_LIMITS.bendsPerWire) wire.bends = points.slice(1, -1);
      else {
        // A failed endpoint repair must not commit a diagonal route. Roll back
        // the complete geometry edit, including wires already repaired above.
        if (routeScene) {
          state.modules = routeScene.modules.map(({ mod, data }) => {
            for (const key of Object.keys(mod)) delete mod[key];
            Object.assign(mod, structuredClone(data));
            return mod;
          });
          state.wires = routeScene.wires.map(saved => saved.wire);
          restoreWireRoutes(routeScene.wires);
        }
        wire.routeWarning = 'Endpoint repair exceeds the bend-point limit. Adjust the route.';
        return false;
      }
    }
    routeBaselines.set(wire, signature);
    const valid = validateRoute(points, context);
    if (!valid && mode === 'auto' && reroute) {
      setWireSmartBends(wire, { remember: false });
    } else if (!valid) {
      wire.routeWarning = 'Route conflicts with a module or port direction. Adjust it or recompute Smart Route.';
    } else delete wire.routeWarning;
  }
  if (reroute) saveRouteScene();
  return true;
}

export function finishWireEdit(wire) {
  if (!wire || routeMode(wire) === 'simple') return;
  const context = getWireRouteContext(wire);
  if (!context) return;
  const points = simplifyRoute(getWirePathPoints(wire, context.start, context.end));
  wire.bends = points.slice(1, -1);
  routeBaselines.set(wire, terminalSignature(context));
  if (!validateRoute(points, context)) wire.routeWarning = 'Manual route conflicts with a module or port direction.';
  else delete wire.routeWarning;
  saveRouteScene();
}

export function editWireSegment(wire, index, value) {
  const context = getWireRouteContext(wire);
  if (!context) return false;
  const points = moveRouteSegment(getWirePathPoints(wire, context.start, context.end), index, value, context);
  if (!points) return false;
  wire.bends = points.slice(1, -1);
  wire.routingMode = 'manual';
  return true;
}

function getDefaultWireRoute(from, to) {
  const fromSide = getPortByRef(from)?.port.side;
  const toSide = getPortByRef(to)?.port.side;

  if (isVerticalPortSide(fromSide) && isVerticalPortSide(toSide)) {
    return "V";
  }
  if (isHorizontalPortSide(fromSide) && isHorizontalPortSide(toSide)) {
    return "H";
  }
  return "H";
}

export function createWire(from, to, selectCallback) {
  if (state.wires.length >= DIAGRAM_LIMITS.wires) {
    return null;
  }
  const wire = {
    id: uid("wire"),
    from,
    to,
    label: "",
    labelAt: "end",
    route: getDefaultWireRoute(from, to),
    bend: 0,
    bends: null,
    color: DEFAULT_WIRE.color,
    width: DEFAULT_WIRE.width,
    style: DEFAULT_WIRE.style,
  };
  setWireDefaultBend(wire);
  // 默认不开启智能连线
  // setWireSmartBends(wire);
  state.wires.push(wire);
  saveRouteScene();
  if (selectCallback) {
    selectCallback({ type: "wire", id: wire.id });
  }
  return wire;
}

/**
 * 同步SVG尺寸
 */
export function syncSvgSize() {
  wireLayer.setAttribute("width", canvas.clientWidth);
  wireLayer.setAttribute("height", canvas.clientHeight);
}

function patchWireGeometry(wire, portIndex = null) {
  const entry = wire && wireDomEntries.get(wire.id);
  if (!entry || !wire) {
    return false;
  }

  const describeRef = (ref) => describePortRefWithIndex(ref, portIndex);

  const hasLabel = Boolean(wire.label);
  if (hasLabel !== Boolean(entry.label)) {
    return false;
  }

  const isSelected = state.selection && state.selection.type === "wire" && state.selection.id === wire.id;
  const strokeColor = typeof wire.color === "string" && wire.color ? wire.color : DEFAULT_WIRE.color;
  const baseWidth = Number.isFinite(wire.width) ? wire.width : DEFAULT_WIRE.width;
  const dash = WIRE_STYLES[wire.style] || "";
  entry.hitPath.setAttribute("stroke-width", Math.max(24, baseWidth + 16));
  entry.hitPath.setAttribute(
    "aria-label",
    wire.label
      ? `Wire ${wire.label}, ${describeRef(wire.from)} to ${describeRef(wire.to)}`
      : `Wire, ${describeRef(wire.from)} to ${describeRef(wire.to)}`
  );
  entry.path.setAttribute("stroke", strokeColor);
  if (wire.routeWarning) entry.path.classList.add('route-conflict');
  else entry.path.classList.remove('route-conflict');
  entry.path.setAttribute("stroke-width", isSelected ? baseWidth + 1 : baseWidth);
  if (dash) {
    entry.path.setAttribute("stroke-dasharray", dash);
  } else {
    entry.path.removeAttribute("stroke-dasharray");
  }

  const start = getPortPositionByRef(wire.from, portIndex);
  const end = getPortPositionByRef(wire.to, portIndex);
  if (!start || !end) {
    return false;
  }

  entry.hitPath.setAttribute("d", buildWirePath(wire, start, end));
  entry.path.setAttribute("d", buildWirePath(wire, start, end));
  if (entry.label) {
    entry.label.textContent = wire.label;
    entry.label.setAttribute("fill", strokeColor);
    applyWireLabelGeometry(entry.label, wireLabelPosition(wire, start, end));
  }

  const bendPoints = getWireBendPoints(wire, start, end);
  if (bendPoints.length !== entry.bendMarkers.length) {
    entry.bendMarkers.forEach((marker) => marker.remove());
    entry.bendMarkers = bendPoints.map((point) => {
      const marker = svgEl("circle", {
        cx: point.x,
        cy: point.y,
        r: Math.max(BEND_MARKER_MIN_RADIUS, baseWidth * 0.7),
        class: "wire-bend",
        fill: strokeColor,
      });
      if (wireHandleLayer && typeof wireLayer.insertBefore === "function") {
        wireLayer.insertBefore(marker, wireHandleLayer);
      } else {
        wireLayer.appendChild(marker);
      }
      return marker;
    });
  }
  bendPoints.forEach((point, index) => {
    const marker = entry.bendMarkers[index];
    const overlapBoost = marker.classList.contains("overlap") ? BEND_MARKER_OVERLAP_BOOST : 0;
    marker.setAttribute("cx", point.x);
    marker.setAttribute("cy", point.y);
    marker.setAttribute("fill", strokeColor);
    marker.setAttribute("r", Math.max(BEND_MARKER_MIN_RADIUS, baseWidth * 0.7) + overlapBoost);
  });

  const handlePositions = getWireHandlePositions(wire, start, end);
  if (entry.handles.length > 0 && handlePositions.length !== entry.handles.length) {
    return false;
  }
  if (entry.handles.length > 0) {
    handlePositions.forEach((position, index) => {
      entry.handles[index].setAttribute("cx", position.x);
      entry.handles[index].setAttribute("cy", position.y);
    });
  }
  return true;
}

/**
 * Patch only the geometry for one already-rendered wire. This is used during
 * drag gestures; a full render on pointerup recomputes overlap markers.
 */
export function updateWireGeometry(wireId) {
  const wire = state.wires.find((item) => item.id === wireId);
  return patchWireGeometry(wire);
}

export function updateWiresForModule(moduleId) {
  if (wireDomEntries.size !== state.wires.length) {
    return false;
  }
  let updated = true;
  const portIndex = buildModulePortIndex();
  state.wires.forEach((wire) => {
    if (wire.from.moduleId === moduleId || wire.to.moduleId === moduleId) {
      updated = patchWireGeometry(wire, portIndex) && updated;
    }
  });
  return updated;
}

export function updateConnectionPreview() {
  if (!state.connecting || !state.connecting.cursor || !connectionPreviewElement) {
    return false;
  }
  const start = getPortPositionByRef(state.connecting.from);
  if (!start) {
    return false;
  }
  const fromSide = getPortByRef(state.connecting.from)?.port.side;
  connectionPreviewElement.setAttribute(
    "d",
    buildConnectionPreviewPath(start, state.connecting.cursor, fromSide)
  );
  return true;
}

/**
 * 更新连线渲染
 */
export function updateWires(selectCallback, startWireDragCallback) {
  syncSvgSize();
  wireLayer.innerHTML = "";
  wireDomEntries.clear();
  connectionPreviewElement = null;
  wireHandleLayer = null;

  const { renderItems, bendPointMap, renderItemMap, portIndex } = collectWireRenderItems();
  const overlapKeys = computeWireOverlapKeys(renderItems, bendPointMap, renderItemMap);
  const hitLayer = svgEl("g", { class: "wire-hit-layer" });
  const handleLayer = svgEl("g", { class: "wire-handle-layer" });
  wireHandleLayer = handleLayer;
  wireLayer.appendChild(hitLayer);

  renderItems.forEach(({ wire, start, end, bendPoints }) => {
    const isSelected = state.selection && state.selection.type === "wire" && state.selection.id === wire.id;
    const strokeColor = typeof wire.color === "string" && wire.color ? wire.color : DEFAULT_WIRE.color;
    const baseWidth = Number.isFinite(wire.width) ? wire.width : DEFAULT_WIRE.width;
    const strokeWidth = isSelected ? baseWidth + 1 : baseWidth;
    const dash = WIRE_STYLES[wire.style] || "";
    const pathAttrs = {
      d: buildWirePath(wire, start, end),
      class: `wire wire-visual${isSelected ? " selected" : ""}${wire.routeWarning ? ' route-conflict' : ''}`,
      stroke: strokeColor,
      "stroke-width": strokeWidth,
    };
    if (dash) {
      pathAttrs["stroke-dasharray"] = dash;
    }
    const hitPath = svgEl("path", {
      d: pathAttrs.d,
      class: "wire-hit",
      fill: "none",
      stroke: "transparent",
      "stroke-width": Math.max(24, baseWidth + 16),
      "vector-effect": "non-scaling-stroke",
      tabindex: 0,
      role: "button",
      "data-wire-id": wire.id,
      "aria-pressed": isSelected ? "true" : "false",
      "aria-label": wire.label
        ? `Wire ${wire.label}, ${describePortRefWithIndex(wire.from, portIndex)} to ${describePortRefWithIndex(wire.to, portIndex)}`
        : `Wire, ${describePortRefWithIndex(wire.from, portIndex)} to ${describePortRefWithIndex(wire.to, portIndex)}`,
    });
    const path = svgEl("path", pathAttrs);
    const domEntry = {
      hitPath,
      path,
      label: null,
      bendMarkers: [],
      handles: [],
    };
    hitPath.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.stopPropagation();
      if (selectCallback) {
        selectCallback({ type: "wire", id: wire.id });
      }
    });
    hitPath.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (selectCallback) {
        selectCallback({ type: "wire", id: wire.id });
      }
    });
    hitPath.addEventListener("focus", () => path.classList.add("keyboard-focus"));
    hitPath.addEventListener("blur", () => path.classList.remove("keyboard-focus"));
    hitLayer.appendChild(hitPath);
    wireLayer.appendChild(path);

    if (bendPoints.length > 0) {
      const baseRadius = Math.max(BEND_MARKER_MIN_RADIUS, baseWidth * 0.7);
      bendPoints.forEach((point) => {
        const key = pointKey(point);
        const isOverlap = overlapKeys.has(key);
        const marker = svgEl("circle", {
          cx: point.x,
          cy: point.y,
          r: isOverlap ? baseRadius + BEND_MARKER_OVERLAP_BOOST : baseRadius,
          class: `wire-bend${isOverlap ? " overlap" : ""}`,
          fill: strokeColor,
        });
        domEntry.bendMarkers.push(marker);
        wireLayer.appendChild(marker);
      });
    }

    if (wire.label) {
      const labelPos = wireLabelPosition(wire, start, end);
      const labelAttrs = {
        x: labelPos.x,
        y: labelPos.y,
        class: "wire-label wire-hit",
        fill: strokeColor,
        "text-anchor": labelPos.anchor || "middle",
        "dominant-baseline": labelPos.baseline || "central",
      };
      if (labelPos.angle) {
        labelAttrs.transform = `rotate(${labelPos.angle} ${labelPos.x} ${labelPos.y})`;
      }
      const label = svgEl("text", labelAttrs);
      label.textContent = wire.label;
      domEntry.label = label;
      label.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }
        event.stopPropagation();
        if (selectCallback) {
          selectCallback({ type: "wire", id: wire.id });
        }
      });
      wireLayer.appendChild(label);
    }

    if (isSelected) {
      const handlePositions = getWireHandlePositions(wire, start, end);
      handlePositions.forEach((pos) => {
        const isHorizontalHandle = pos.segmentIndex !== undefined ? pos.isHorizontal : wire.route === "V";
        const handle = svgEl("circle", {
          cx: pos.x,
          cy: pos.y,
          r: 6,
          class: `wire-handle ${isHorizontalHandle ? "horizontal" : "vertical"}`,
        });
        domEntry.handles.push(handle);
        handle.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) {
            return;
          }
          event.stopPropagation();
          if (startWireDragCallback) {
            // 传递额外信息用于智能路由线段调整
            startWireDragCallback(event, wire, pos.index, pos.segmentIndex, pos.isHorizontal);
          }
        });
        handleLayer.appendChild(handle);
      });
    }
    wireDomEntries.set(wire.id, domEntry);
  });

  wireLayer.appendChild(handleLayer);

  if (state.connecting && state.connecting.cursor) {
    const start = getPortPositionByRef(state.connecting.from);
    if (start) {
      const end = state.connecting.cursor;
      const fromSide = getPortByRef(state.connecting.from)?.port.side;
      const previewPath = buildConnectionPreviewPath(start, end, fromSide);
      const preview = svgEl("path", {
        d: previewPath,
        class: "wire preview",
      });
      connectionPreviewElement = preview;
      wireLayer.appendChild(preview);
    }
  }
}
