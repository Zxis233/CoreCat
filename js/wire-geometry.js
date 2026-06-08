/**
 * Wire geometry - pure wire path, handle, label, and overlap helpers.
 */

import { DEFAULT_WIRE } from './constants.js';

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

export function getWireHandlePositions(wire, start, end) {
  if (Array.isArray(wire.bends) && wire.bends.length > 0) {
    const handles = [];
    const points = [start, ...wire.bends, end];

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      handles.push({
        x: (p1.x + p2.x) / 2,
        y: (p1.y + p2.y) / 2,
        segmentIndex: i,
        isHorizontal: p1.y === p2.y,
        index: i,
      });
    }
    return handles;
  }

  if (wire.route === "V") {
    return [{ x: (start.x + end.x) / 2, y: wire.bend, index: -1 }];
  }
  return [{ x: wire.bend, y: (start.y + end.y) / 2, index: -1 }];
}

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

function getWireEndSegmentStart(wire, end) {
  if (Array.isArray(wire.bends) && wire.bends.length > 0) {
    return wire.bends[wire.bends.length - 1];
  }
  if (wire.route === "V") {
    return { x: end.x, y: wire.bend };
  }
  return { x: wire.bend, y: end.y };
}

function getWireStartSegmentEnd(wire, start) {
  if (Array.isArray(wire.bends) && wire.bends.length > 0) {
    return wire.bends[0];
  }
  if (wire.route === "V") {
    return { x: start.x, y: wire.bend };
  }
  return { x: wire.bend, y: start.y };
}

export function wireLabelPosition(wire, start, end) {
  if (!start || !end) {
    return { x: 0, y: 0, anchor: "middle", baseline: "central", angle: 0 };
  }

  const baseWidth = Number.isFinite(wire.width) ? wire.width : DEFAULT_WIRE.width;
  const extraOffset = Math.max(0, (baseWidth - DEFAULT_WIRE.width) / 2);
  const labelOffset = LABEL_OFFSET + extraOffset;
  const labelAt = wire && wire.labelAt === "start" ? "start" : "end";
  const isStart = labelAt === "start";
  const segmentStart = isStart ? start : getWireEndSegmentStart(wire, end);
  const segmentEnd = isStart ? getWireStartSegmentEnd(wire, start) : end;
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
