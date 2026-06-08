/**
 * Wire - 连线相关功能
 * 包含连线创建、路由、渲染等
 */

import { state, wireLayer, canvas } from './state.js';
import { DEFAULT_WIRE, WIRE_STYLES, WIRE_MARGIN } from './constants.js';
import { uid, svgEl, getModuleById } from './utils.js';
import { getPortPositionByRef, describePortRef } from './port.js';

const LABEL_OFFSET = 10;
const LABEL_ALONG_OFFSET = 10;
export const BEND_MARKER_MIN_RADIUS = 2.5;
export const BEND_MARKER_OVERLAP_BOOST = 2.5;
export const BEND_OVERLAP_EPS = 0.5;
const DIRECT_SEGMENT_SCAN_LIMIT = 2000000;
const DEDUPED_DIRECT_SEGMENT_SCAN_LIMIT = 50000000;
const DEDUPED_DIRECT_POINT_RATIO = 0.4;
const POINT_AXIS_SEARCH_RADIUS = 1;

export function pointKey(point) {
  return `${Math.round(point.x)}:${Math.round(point.y)}`;
}

export function getWireBendPoints(wire, start, end) {
  if (!start || !end) {
    return [];
  }

  let points = [];

  if (Array.isArray(wire.bends) && wire.bends.length > 0) {
    points = wire.bends.map((bend) => ({ x: bend.x, y: bend.y }));
  } else {
    if (start.x === end.x || start.y === end.y) {
      return [];
    }
    if (wire.route === "V") {
      points = [
        { x: start.x, y: wire.bend },
        { x: end.x, y: wire.bend },
      ];
    } else {
      points = [
        { x: wire.bend, y: start.y },
        { x: wire.bend, y: end.y },
      ];
    }
  }

  const startKey = pointKey(start);
  const endKey = pointKey(end);
  const seen = new Set();
  const result = [];

  for (const point of points) {
    const key = pointKey(point);
    if (key === startKey || key === endKey) {
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(point);
  }

  return result;
}

export function getWirePathPoints(wire, start, end) {
  if (!start || !end) {
    return [];
  }

  if (Array.isArray(wire.bends) && wire.bends.length > 0) {
    return [start, ...wire.bends, end];
  }

  if (wire.route === "V") {
    return [
      start,
      { x: start.x, y: wire.bend },
      { x: end.x, y: wire.bend },
      end,
    ];
  }

  return [
    start,
    { x: wire.bend, y: start.y },
    { x: wire.bend, y: end.y },
    end,
  ];
}

export function getWireSegments(points) {
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    if (p1.x === p2.x && p1.y === p2.y) {
      continue;
    }
    segments.push({
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
    });
  }
  return segments;
}

export function getDirection(from, to) {
  if (from.x === to.x) {
    return to.y > from.y ? "down" : "up";
  }
  if (from.y === to.y) {
    return to.x > from.x ? "right" : "left";
  }
  return null;
}

export function getOutgoingDirection(points, index) {
  const curr = points[index];
  for (let i = index + 1; i < points.length; i++) {
    const next = points[i];
    if (next.x === curr.x && next.y === curr.y) {
      continue;
    }
    return getDirection(curr, next);
  }
  return null;
}

export function isPointOnSegment(point, segment) {
  if (segment.x1 === segment.x2) {
    if (Math.abs(point.x - segment.x1) > BEND_OVERLAP_EPS) {
      return false;
    }
    const minY = Math.min(segment.y1, segment.y2) - BEND_OVERLAP_EPS;
    const maxY = Math.max(segment.y1, segment.y2) + BEND_OVERLAP_EPS;
    return point.y >= minY && point.y <= maxY;
  }
  if (segment.y1 === segment.y2) {
    if (Math.abs(point.y - segment.y1) > BEND_OVERLAP_EPS) {
      return false;
    }
    const minX = Math.min(segment.x1, segment.x2) - BEND_OVERLAP_EPS;
    const maxX = Math.max(segment.x1, segment.x2) + BEND_OVERLAP_EPS;
    return point.x >= minX && point.x <= maxX;
  }
  return false;
}

function addSetMapValue(map, key, value) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  map.get(key).add(value);
}

function addArrayMapValue(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function addPointToAxisIndex(index, axisValue, positionValue, point, check) {
  addArrayMapValue(index, Math.round(axisValue), { position: positionValue, point, check });
}

function buildPendingPointAxisIndex(overlapChecks) {
  const horizontal = new Map();
  const vertical = new Map();

  overlapChecks.forEach((check) => {
    check.points.forEach((point) => {
      addPointToAxisIndex(horizontal, point.y, point.x, point, check);
      addPointToAxisIndex(vertical, point.x, point.y, point, check);
    });
  });

  horizontal.forEach((points) => points.sort((a, b) => a.position - b.position));
  vertical.forEach((points) => points.sort((a, b) => a.position - b.position));

  return { horizontal, vertical };
}

function lowerBoundByPosition(points, target) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].position < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function scannedSegmentHitsPoint(point, bendWireIds, renderItems) {
  for (const other of renderItems) {
    if (bendWireIds && bendWireIds.has(other.wire.id)) {
      continue;
    }
    for (const segment of other.segments) {
      if (isPointOnSegment(point, segment)) {
        return true;
      }
    }
  }
  return false;
}

function collectPendingOverlapChecks(renderItems, bendPointMap, overlapKeys) {
  const checkMap = new Map();

  renderItems.forEach((item) => {
    item.bendPoints.forEach((point) => {
      const key = pointKey(point);
      if (overlapKeys.has(key)) {
        return;
      }
      let check = checkMap.get(key);
      if (!check) {
        check = {
          key,
          bendWireIds: bendPointMap.get(key),
          points: [],
          pointSignatures: new Set(),
        };
        checkMap.set(key, check);
      }
      const pointSignature = `${point.x}:${point.y}`;
      if (!check.pointSignatures.has(pointSignature)) {
        check.pointSignatures.add(pointSignature);
        check.points.push(point);
      }
    });
  });

  return Array.from(checkMap.values(), ({ key, bendWireIds, points }) => ({
    key,
    bendWireIds,
    points,
  }));
}

function markOverlapsByScanning(overlapChecks, renderItems, overlapKeys) {
  overlapChecks.forEach(({ key, bendWireIds, points }) => {
    if (overlapKeys.has(key)) {
      return;
    }
    for (const point of points) {
      if (scannedSegmentHitsPoint(point, bendWireIds, renderItems)) {
        overlapKeys.add(key);
        break;
      }
    }
  });
}

function visitIndexedPoints(index, axisValue, from, to, callback) {
  const axisKey = Math.round(axisValue);
  const min = Math.min(from, to) - BEND_OVERLAP_EPS;
  const max = Math.max(from, to) + BEND_OVERLAP_EPS;

  for (let axisOffset = -POINT_AXIS_SEARCH_RADIUS; axisOffset <= POINT_AXIS_SEARCH_RADIUS; axisOffset += 1) {
    const points = index.get(axisKey + axisOffset);
    if (!points) {
      continue;
    }
    for (let i = lowerBoundByPosition(points, min); i < points.length && points[i].position <= max; i += 1) {
      callback(points[i]);
    }
  }
}

function markOverlapsByPointIndex(overlapChecks, renderItems, overlapKeys) {
  const axisIndex = buildPendingPointAxisIndex(overlapChecks);
  const remainingKeys = new Set(overlapChecks.map((check) => check.key));

  for (const item of renderItems) {
    for (const segment of item.segments) {
      if (remainingKeys.size === 0) {
        return;
      }
      const visit = ({ point, check }) => {
        if (!remainingKeys.has(check.key)) {
          return;
        }
        if (check.bendWireIds && check.bendWireIds.has(item.wire.id)) {
          return;
        }
        if (isPointOnSegment(point, segment)) {
          overlapKeys.add(check.key);
          remainingKeys.delete(check.key);
        }
      };
      if (segment.y1 === segment.y2) {
        visitIndexedPoints(axisIndex.horizontal, segment.y1, segment.x1, segment.x2, visit);
      } else if (segment.x1 === segment.x2) {
        visitIndexedPoints(axisIndex.vertical, segment.x1, segment.y1, segment.y2, visit);
      }
    }
  }
}

export function collectWireRenderItems(wires = state.wires) {
  const renderItems = [];
  const bendPointMap = new Map();
  const renderItemMap = new Map();

  wires.forEach((wire) => {
    const start = getPortPositionByRef(wire.from);
    const end = getPortPositionByRef(wire.to);
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

  return { renderItems, bendPointMap, renderItemMap };
}

export function computeWireOverlapKeys(renderItems, bendPointMap, renderItemMap) {
  const overlapKeys = new Set();

  bendPointMap.forEach((wireIds, key) => {
    if (wireIds.size <= 1) {
      return;
    }
    const directions = new Set();
    wireIds.forEach((wireId) => {
      const item = renderItemMap.get(wireId);
      if (!item) {
        return;
      }
      const dirSet = item.bendDirections.get(key);
      if (!dirSet) {
        return;
      }
      dirSet.forEach((dir) => directions.add(dir));
    });
    if (directions.size > 1) {
      overlapKeys.add(key);
    }
  });

  const overlapChecks = collectPendingOverlapChecks(renderItems, bendPointMap, overlapKeys);
  if (overlapChecks.length === 0) {
    return overlapKeys;
  }

  const pendingPointCount = overlapChecks.reduce((total, check) => total + check.points.length, 0);
  const segmentCount = renderItems.reduce((total, item) => total + item.segments.length, 0);
  const rawBendPointCount = renderItems.reduce((total, item) => total + item.bendPoints.length, 0);
  const estimatedSegmentChecks = pendingPointCount * segmentCount;
  const dedupedPointRatio = pendingPointCount / Math.max(rawBendPointCount, 1);
  const useDirectScan = estimatedSegmentChecks <= DIRECT_SEGMENT_SCAN_LIMIT
    || (dedupedPointRatio <= DEDUPED_DIRECT_POINT_RATIO
      && estimatedSegmentChecks <= DEDUPED_DIRECT_SEGMENT_SCAN_LIMIT);

  if (useDirectScan) {
    markOverlapsByScanning(overlapChecks, renderItems, overlapKeys);
    return overlapKeys;
  }

  markOverlapsByPointIndex(overlapChecks, renderItems, overlapKeys);

  return overlapKeys;
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
    wire.bends = smartRoute.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  }
}

export function createWire(from, to, selectCallback) {
  const wire = {
    id: uid("wire"),
    from,
    to,
    label: "",
    labelAt: "end",
    route: "H",
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
}

/**
 * 构建连线路径
 */
export function buildWirePath(wire, start, end) {
  if (Array.isArray(wire.bends) && wire.bends.length > 0) {
    let path = `M ${start.x} ${start.y}`;
    for (const bend of wire.bends) {
      path += ` L ${bend.x} ${bend.y}`;
    }
    path += ` L ${end.x} ${end.y}`;
    return path;
  }

  if (wire.route === "V") {
    const midY = wire.bend;
    return `M ${start.x} ${start.y} L ${start.x} ${midY} L ${end.x} ${midY} L ${end.x} ${end.y}`;
  }
  const midX = wire.bend;
  return `M ${start.x} ${start.y} L ${midX} ${start.y} L ${midX} ${end.y} L ${end.x} ${end.y}`;
}

/**
 * 获取连线手柄位置数组
 * 对于智能路由（SmartRoute，wire.bends 数组存在时），为每条线段返回一个手柄
 * 对于简单路由（wire.bend 单值），返回中间位置的手柄
 * 注意：wire.bends 仅由 setWireSmartBends() 设置，普通连线不会有此属性
 */
export function getWireHandlePositions(wire, start, end) {
  if (Array.isArray(wire.bends) && wire.bends.length > 0) {
    // 智能路由：为每条线段创建一个手柄
    // 线段由 start -> bends[0] -> bends[1] -> ... -> bends[n-1] -> end 组成
    const handles = [];
    const points = [start, ...wire.bends, end];

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      // 手柄位置在线段中点
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      // 判断线段方向：智能路由只产生水平和垂直线段
      // 使用精确的 Y 坐标比较来判断是否为水平线段
      const isHorizontal = p1.y === p2.y;
      // segmentIndex 表示线段索引，direction 表示线段方向（用于约束拖拽）
      handles.push({
        x: midX,
        y: midY,
        segmentIndex: i,
        isHorizontal: isHorizontal,
        index: i  // 保持兼容性
      });
    }
    return handles;
  }

  if (wire.route === "V") {
    return [{ x: (start.x + end.x) / 2, y: wire.bend, index: -1 }];
  }
  return [{ x: wire.bend, y: (start.y + end.y) / 2, index: -1 }];
}

/**
 * 获取连线手柄位置
 */
export function wireHandlePosition(wire, start, end) {
  if (Array.isArray(wire.bends) && wire.bends.length > 0) {
    const midIndex = Math.floor(wire.bends.length / 2);
    return { x: wire.bends[midIndex].x, y: wire.bends[midIndex].y };
  }

  if (wire.route === "V") {
    return { x: (start.x + end.x) / 2, y: wire.bend };
  }
  return { x: wire.bend, y: (start.y + end.y) / 2 };
}

function getWireEndSegmentStart(wire, start, end) {
  if (Array.isArray(wire.bends) && wire.bends.length > 0) {
    return wire.bends[wire.bends.length - 1];
  }
  if (wire.route === "V") {
    return { x: end.x, y: wire.bend };
  }
  return { x: wire.bend, y: end.y };
}

function getWireStartSegmentEnd(wire, start, end) {
  if (Array.isArray(wire.bends) && wire.bends.length > 0) {
    return wire.bends[0];
  }
  if (wire.route === "V") {
    return { x: start.x, y: wire.bend };
  }
  return { x: wire.bend, y: start.y };
}

/**
 * 获取连线标签位置
 */
export function wireLabelPosition(wire, start, end) {
  if (!start || !end) {
    return { x: 0, y: 0, anchor: "middle", baseline: "central", angle: 0 };
  }

  const baseWidth = Number.isFinite(wire.width) ? wire.width : DEFAULT_WIRE.width;
  const extraOffset = Math.max(0, (baseWidth - DEFAULT_WIRE.width) / 2);
  const labelOffset = LABEL_OFFSET + extraOffset;
  const labelAt = wire && wire.labelAt === "start" ? "start" : "end";
  const isStart = labelAt === "start";
  const segmentStart = isStart ? start : getWireEndSegmentStart(wire, start, end);
  const segmentEnd = isStart ? getWireStartSegmentEnd(wire, start, end) : end;
  const point = isStart ? start : end;
  const dx = segmentEnd.x - segmentStart.x;
  const dy = segmentEnd.y - segmentStart.y;
  const isHorizontal = dy === 0;
  const dir = (value) => (value === 0 ? 1 : Math.sign(value));

  if (isHorizontal) {
    const axisDir = dir(dx);
    return {
      x: point.x + (isStart ? axisDir : -axisDir) * LABEL_ALONG_OFFSET,
      y: point.y - labelOffset,
      anchor: axisDir > 0 ? (isStart ? "start" : "end") : (isStart ? "end" : "start"),
      baseline: "central",
      angle: 0,
    };
  }

  const axisDir = dir(dy);
  return {
    x: point.x + labelOffset,
    y: point.y + (isStart ? axisDir : -axisDir) * LABEL_ALONG_OFFSET,
    anchor: axisDir > 0 ? (isStart ? "start" : "end") : (isStart ? "end" : "start"),
    baseline: "central",
    angle: 90,
  };
}

/**
 * 同步SVG尺寸
 */
export function syncSvgSize() {
  wireLayer.setAttribute("width", canvas.clientWidth);
  wireLayer.setAttribute("height", canvas.clientHeight);
}

/**
 * 更新连线渲染
 */
export function updateWires(selectCallback, startWireDragCallback) {
  syncSvgSize();
  wireLayer.innerHTML = "";

  const { renderItems, bendPointMap, renderItemMap } = collectWireRenderItems();
  const overlapKeys = computeWireOverlapKeys(renderItems, bendPointMap, renderItemMap);

  renderItems.forEach(({ wire, start, end, bendPoints }) => {
    const isSelected = state.selection && state.selection.type === "wire" && state.selection.id === wire.id;
    const strokeColor = typeof wire.color === "string" && wire.color ? wire.color : DEFAULT_WIRE.color;
    const baseWidth = Number.isFinite(wire.width) ? wire.width : DEFAULT_WIRE.width;
    const strokeWidth = isSelected ? baseWidth + 1 : baseWidth;
    const dash = WIRE_STYLES[wire.style] || "";
    const pathAttrs = {
      d: buildWirePath(wire, start, end),
      class: `wire wire-hit${isSelected ? " selected" : ""}`,
      stroke: strokeColor,
      "stroke-width": strokeWidth,
    };
    if (dash) {
      pathAttrs["stroke-dasharray"] = dash;
    }
    const path = svgEl("path", pathAttrs);
    path.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      if (selectCallback) {
        selectCallback({ type: "wire", id: wire.id });
      }
    });
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
      label.addEventListener("pointerdown", (event) => {
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
        const handle = svgEl("circle", {
          cx: pos.x,
          cy: pos.y,
          r: 6,
          class: "wire-handle",
        });
        handle.addEventListener("pointerdown", (event) => {
          event.stopPropagation();
          if (startWireDragCallback) {
            // 传递额外信息用于智能路由线段调整
            startWireDragCallback(event, wire, pos.index, pos.segmentIndex, pos.isHorizontal);
          }
        });
        wireLayer.appendChild(handle);
      });
    }
  });

  if (state.connecting && state.connecting.cursor) {
    const start = getPortPositionByRef(state.connecting.from);
    if (start) {
      const end = state.connecting.cursor;
      const midX = (start.x + end.x) / 2;
      const preview = svgEl("path", {
        d: `M ${start.x} ${start.y} L ${midX} ${start.y} L ${midX} ${end.y} L ${end.x} ${end.y}`,
        class: "wire preview",
      });
      wireLayer.appendChild(preview);
    }
  }
}
