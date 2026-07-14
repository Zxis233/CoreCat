/**
 * Wire - 连线相关功能
 * 包含连线创建、路由、渲染等
 */

import { state, wireLayer, canvas } from './state.js';
import { DEFAULT_WIRE, WIRE_STYLES, WIRE_MARGIN, DIAGRAM_LIMITS } from './constants.js';
import { uid, svgEl } from './utils.js';
import { buildModulePortIndex, describePortRef, getPortByRef, getPortPositionByRef } from './port.js';
import { isHorizontalPortSide, isVerticalPortSide } from './interaction-logic.js';
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
}

/**
 * 获取模块边界框（含边距）
 */
function getModuleBounds(mod, margin = WIRE_MARGIN) {
  return {
    left: mod.x - margin,
    right: mod.x + mod.width + margin,
    top: mod.y - margin,
    bottom: mod.y + mod.height + margin,
  };
}

/**
 * 检查水平线段是否与矩形相交
 */
function hLineIntersectsRect(y, x1, x2, rect) {
  if (y <= rect.top || y >= rect.bottom) return false;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  return maxX > rect.left && minX < rect.right;
}

/**
 * 检查垂直线段是否与矩形相交
 */
function vLineIntersectsRect(x, y1, y2, rect) {
  if (x <= rect.left || x >= rect.right) return false;
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  return maxY > rect.top && minY < rect.bottom;
}

/**
 * 获取障碍物模块
 */
function getObstacleModules(wire, includeEndpoints = false) {
  if (includeEndpoints) {
    return state.modules;
  }
  return state.modules.filter((mod) => mod.id !== wire.from.moduleId && mod.id !== wire.to.moduleId);
}

/**
 * 检查路径碰撞
 */
function checkPathCollision(wire, start, end) {
  const allModules = getObstacleModules(wire, true);

  for (const mod of allModules) {
    const rect = getModuleBounds(mod);

    if (wire.route === "V") {
      const midY = wire.bend;
      if (vLineIntersectsRect(start.x, start.y, midY, rect)) return true;
      if (hLineIntersectsRect(midY, start.x, end.x, rect)) return true;
      if (vLineIntersectsRect(end.x, midY, end.y, rect)) return true;
    } else {
      const midX = wire.bend;
      if (hLineIntersectsRect(start.y, start.x, midX, rect)) return true;
      if (vLineIntersectsRect(midX, start.y, end.y, rect)) return true;
      if (hLineIntersectsRect(end.y, midX, end.x, rect)) return true;
    }
  }

  return false;
}

/**
 * 计算智能路由
 */
function computeSmartRoute(wire, start, end) {
  const allModules = getObstacleModules(wire, true);
  if (allModules.length === 0) return null;

  const margin = WIRE_MARGIN;

  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);

  const relevantModules = allModules.filter((mod) => {
    const rect = getModuleBounds(mod, margin);
    return !(rect.right < minX - margin || rect.left > maxX + margin ||
      rect.bottom < minY - margin || rect.top > maxY + margin);
  });

  if (relevantModules.length === 0) return null;

  let combinedLeft = Infinity, combinedRight = -Infinity;
  let combinedTop = Infinity, combinedBottom = -Infinity;

  for (const mod of relevantModules) {
    const rect = getModuleBounds(mod, margin);
    combinedLeft = Math.min(combinedLeft, rect.left);
    combinedRight = Math.max(combinedRight, rect.right);
    combinedTop = Math.min(combinedTop, rect.top);
    combinedBottom = Math.max(combinedBottom, rect.bottom);
  }

  if (wire.route === "H") {
    let midX1, midX2;

    if (start.x >= combinedRight - margin) {
      midX1 = combinedRight + margin;
    } else if (start.x <= combinedLeft + margin) {
      midX1 = combinedLeft - margin;
    } else {
      const distToRight = combinedRight - start.x;
      const distToLeft = start.x - combinedLeft;
      midX1 = distToRight < distToLeft ? combinedRight + margin : combinedLeft - margin;
    }

    if (end.x >= combinedRight - margin) {
      midX2 = combinedRight + margin;
    } else if (end.x <= combinedLeft + margin) {
      midX2 = combinedLeft - margin;
    } else {
      const distToRight = combinedRight - end.x;
      const distToLeft = end.x - combinedLeft;
      midX2 = distToRight < distToLeft ? combinedRight + margin : combinedLeft - margin;
    }

    const topY = combinedTop - margin;
    const routeAbove = [
      { x: midX1, y: start.y },
      { x: midX1, y: topY },
      { x: midX2, y: topY },
      { x: midX2, y: end.y },
    ];

    const bottomY = combinedBottom + margin;
    const routeBelow = [
      { x: midX1, y: start.y },
      { x: midX1, y: bottomY },
      { x: midX2, y: bottomY },
      { x: midX2, y: end.y },
    ];

    const distAbove = Math.abs(topY - start.y) + Math.abs(topY - end.y);
    const distBelow = Math.abs(bottomY - start.y) + Math.abs(bottomY - end.y);

    return distAbove < distBelow ? routeAbove : routeBelow;
  } else {
    let midY1, midY2;

    if (start.y >= combinedBottom - margin) {
      midY1 = combinedBottom + margin;
    } else if (start.y <= combinedTop + margin) {
      midY1 = combinedTop - margin;
    } else {
      const distToBottom = combinedBottom - start.y;
      const distToTop = start.y - combinedTop;
      midY1 = distToBottom < distToTop ? combinedBottom + margin : combinedTop - margin;
    }

    if (end.y >= combinedBottom - margin) {
      midY2 = combinedBottom + margin;
    } else if (end.y <= combinedTop + margin) {
      midY2 = combinedTop - margin;
    } else {
      const distToBottom = combinedBottom - end.y;
      const distToTop = end.y - combinedTop;
      midY2 = distToBottom < distToTop ? combinedBottom + margin : combinedTop - margin;
    }

    const leftX = combinedLeft - margin;
    const routeLeft = [
      { x: start.x, y: midY1 },
      { x: leftX, y: midY1 },
      { x: leftX, y: midY2 },
      { x: end.x, y: midY2 },
    ];

    const rightX = combinedRight + margin;
    const routeRight = [
      { x: start.x, y: midY1 },
      { x: rightX, y: midY1 },
      { x: rightX, y: midY2 },
      { x: end.x, y: midY2 },
    ];

    const distLeft = Math.abs(leftX - start.x) + Math.abs(leftX - end.x);
    const distRight = Math.abs(rightX - start.x) + Math.abs(rightX - end.x);

    return distLeft < distRight ? routeLeft : routeRight;
  }
}

/**
 * 设置智能路由弯折点
 */
export function setWireSmartBends(wire) {
  const start = getPortPositionByRef(wire.from);
  const end = getPortPositionByRef(wire.to);
  if (!start || !end) return;

  if (!checkPathCollision(wire, start, end)) {
    wire.bends = null;
    return;
  }

  const smartRoute = computeSmartRoute(wire, start, end);
  if (smartRoute) {
    wire.bends = smartRoute
      .slice(0, DIAGRAM_LIMITS.bendsPerWire)
      .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  }
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
      class: `wire wire-visual${isSelected ? " selected" : ""}`,
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
