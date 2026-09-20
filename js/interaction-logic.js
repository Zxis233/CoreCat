/**
 * Interaction logic - drag state updates without DOM work.
 */

import {
  DEFAULT_WIRE_SNAP_MODE,
  GRID_SIZE,
  WIRE_SNAP_DISTANCE,
  WIRE_SNAP_MODES,
} from './constants.js';
import { moveRouteSegment } from './wire-routing.js';

const HORIZONTAL_PORT_SIDES = new Set(["left", "right"]);
const VERTICAL_PORT_SIDES = new Set(["top", "bottom", "slopeTop", "slopeBottom"]);

export function isHorizontalPortSide(side) {
  return HORIZONTAL_PORT_SIDES.has(side);
}

export function isVerticalPortSide(side) {
  return VERTICAL_PORT_SIDES.has(side);
}

export function snapValueToGrid(value, gridSize = GRID_SIZE) {
  if (!Number.isFinite(value)) {
    return value;
  }
  if (!Number.isFinite(gridSize) || gridSize <= 0) {
    return Math.round(value);
  }
  return Math.round(value / gridSize) * gridSize;
}

export function normalizeWireSnapMode(mode) {
  return Object.values(WIRE_SNAP_MODES).includes(mode) ? mode : DEFAULT_WIRE_SNAP_MODE;
}

function addSnapTarget(targets, value) {
  if (!Number.isFinite(value)) {
    return;
  }
  if (targets.some((target) => Math.abs(target - value) < 0.001)) {
    return;
  }
  targets.push(value);
}

export function buildWireSnapContext(start, end, fromSide, toSide, options = {}) {
  const context = {
    gridSize: Number.isFinite(options.gridSize) && options.gridSize > 0 ? options.gridSize : GRID_SIZE,
    threshold: Number.isFinite(options.threshold) ? options.threshold : WIRE_SNAP_DISTANCE,
    mode: normalizeWireSnapMode(options.mode),
    horizontalSnapYs: [],
    verticalSnapXs: [],
  };

  if (start && isHorizontalPortSide(fromSide)) {
    addSnapTarget(context.horizontalSnapYs, start.y);
  }
  if (end && isHorizontalPortSide(toSide)) {
    addSnapTarget(context.horizontalSnapYs, end.y);
  }
  if (start && isVerticalPortSide(fromSide)) {
    addSnapTarget(context.verticalSnapXs, start.x);
  }
  if (end && isVerticalPortSide(toSide)) {
    addSnapTarget(context.verticalSnapXs, end.x);
  }

  return context;
}

function snapValueToTargets(value, targets, threshold) {
  if (!Number.isFinite(value) || !Array.isArray(targets) || targets.length === 0) {
    return null;
  }

  let bestValue = null;
  let bestDistance = Infinity;
  targets.forEach((target) => {
    const distance = Math.abs(value - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestValue = target;
    }
  });

  return bestDistance <= threshold ? bestValue : null;
}

function snapCoordinate(value, targets, snapContext) {
  if (snapContext.mode === WIRE_SNAP_MODES.NONE) {
    return Math.round(value);
  }

  const target = snapValueToTargets(value, targets, snapContext.threshold);
  if (target !== null) {
    return target;
  }

  if (snapContext.mode === WIRE_SNAP_MODES.PORT) {
    return Math.round(value);
  }

  return snapValueToGrid(value, snapContext.gridSize);
}

function normalizeSnapContext(snapContext) {
  if (snapContext && typeof snapContext === "object") {
    return {
      gridSize: Number.isFinite(snapContext.gridSize) && snapContext.gridSize > 0 ? snapContext.gridSize : GRID_SIZE,
      threshold: Number.isFinite(snapContext.threshold) ? snapContext.threshold : WIRE_SNAP_DISTANCE,
      mode: normalizeWireSnapMode(snapContext.mode),
      horizontalSnapYs: Array.isArray(snapContext.horizontalSnapYs) ? snapContext.horizontalSnapYs : [],
      verticalSnapXs: Array.isArray(snapContext.verticalSnapXs) ? snapContext.verticalSnapXs : [],
    };
  }
  return buildWireSnapContext(null, null, null, null);
}

function snapHorizontalSegmentY(value, snapContext) {
  return snapCoordinate(value, snapContext.horizontalSnapYs, snapContext);
}

function snapVerticalSegmentX(value, snapContext) {
  return snapCoordinate(value, snapContext.verticalSnapXs, snapContext);
}

export function snapWirePoint(point, snapContext) {
  const normalizedContext = normalizeSnapContext(snapContext);
  return {
    x: snapVerticalSegmentX(point.x, normalizedContext),
    y: snapHorizontalSegmentY(point.y, normalizedContext),
  };
}

export function snapConnectionCursor(start, cursor, fromSide, options = {}) {
  return snapWirePoint(cursor, buildWireSnapContext(start, null, fromSide, null, options));
}

export function updateModuleDragPosition(mod, drag, event, scale) {
  if (event.shiftKey) {
    if (!drag.axisLock) {
      const dx = (event.clientX - drag.startX) / scale;
      const dy = (event.clientY - drag.startY) / scale;
      drag.axisLock = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      drag.originX = mod.x;
      drag.originY = mod.y;
      drag.startX = event.clientX;
      drag.startY = event.clientY;
    }
  } else if (drag.axisLock) {
    drag.axisLock = null;
    drag.originX = mod.x;
    drag.originY = mod.y;
    drag.startX = event.clientX;
    drag.startY = event.clientY;
  }

  const dx = (event.clientX - drag.startX) / scale;
  const dy = (event.clientY - drag.startY) / scale;
  if (drag.axisLock === "x") {
    mod.x = Math.round(drag.originX + dx);
    mod.y = Math.round(drag.originY);
  } else if (drag.axisLock === "y") {
    mod.x = Math.round(drag.originX);
    mod.y = Math.round(drag.originY + dy);
  } else {
    mod.x = Math.round(drag.originX + dx);
    mod.y = Math.round(drag.originY + dy);
  }

  return { x: mod.x, y: mod.y };
}

export function updateWireDragGeometry(wire, dragWire, clientX, clientY, scale) {
  const dx = (clientX - dragWire.startX) / scale;
  const dy = (clientY - dragWire.startY) / scale;
  const snapContext = normalizeSnapContext(dragWire.snapContext);

  if (dragWire.segmentIndex !== undefined && Array.isArray(wire.bends)) {
    const i = dragWire.segmentIndex, origins = dragWire.origin;
    // Terminal segments are anchored to their ports.
    if (!Number.isInteger(i) || i <= 0 || i >= wire.bends.length || !Array.isArray(origins)) return;
    const axis = dragWire.isHorizontal ? 'y' : 'x';
    const value = dragWire.isHorizontal
      ? snapHorizontalSegmentY(origins[i - 1].y + dy, snapContext)
      : snapVerticalSegmentX(origins[i - 1].x + dx, snapContext);
    if (dragWire.routeContext) {
      const context = dragWire.routeContext;
      const points = moveRouteSegment([context.start, ...origins, context.end], i, value, context);
      if (!points) return;
      wire.bends = points.slice(1, -1);
      if (wire.bends[i - 1][axis] !== origins[i - 1][axis]) wire.routingMode = 'manual';
      return;
    }
    wire.bends[i - 1] = { ...origins[i - 1], [axis]: value };
    wire.bends[i] = { ...origins[i], [axis]: value };
    if (value !== origins[i - 1][axis]) wire.routingMode = 'manual';
    return;
  }

  // Arbitrary point dragging cannot preserve both adjacent segment axes.
  if (dragWire.bendIndex >= 0) return;

  if (dragWire.route === "V") {
    wire.bend = snapHorizontalSegmentY(dragWire.origin + dy, snapContext);
  } else {
    wire.bend = snapVerticalSegmentX(dragWire.origin + dx, snapContext);
  }
}
