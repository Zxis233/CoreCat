/**
 * Interaction logic - drag state updates without DOM work.
 */

import {
  DEFAULT_WIRE_SNAP_MODE,
  GRID_SIZE,
  WIRE_SNAP_DISTANCE,
  WIRE_SNAP_MODES,
} from './constants.js';

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
    const segIdx = dragWire.segmentIndex;
    const isHorizontal = dragWire.isHorizontal;
    const origins = dragWire.origin;
    const numBends = wire.bends.length;

    if (isHorizontal) {
      if (segIdx === 0) {
        wire.bends[0] = {
          x: origins[0].x,
          y: snapHorizontalSegmentY(origins[0].y + dy, snapContext),
        };
      } else if (segIdx === numBends) {
        wire.bends[numBends - 1] = {
          x: origins[numBends - 1].x,
          y: snapHorizontalSegmentY(origins[numBends - 1].y + dy, snapContext),
        };
      } else {
        wire.bends[segIdx - 1] = {
          x: origins[segIdx - 1].x,
          y: snapHorizontalSegmentY(origins[segIdx - 1].y + dy, snapContext),
        };
        wire.bends[segIdx] = {
          x: origins[segIdx].x,
          y: snapHorizontalSegmentY(origins[segIdx].y + dy, snapContext),
        };
      }
    } else if (segIdx === 0) {
      wire.bends[0] = {
        x: snapVerticalSegmentX(origins[0].x + dx, snapContext),
        y: origins[0].y,
      };
    } else if (segIdx === numBends) {
      wire.bends[numBends - 1] = {
        x: snapVerticalSegmentX(origins[numBends - 1].x + dx, snapContext),
        y: origins[numBends - 1].y,
      };
    } else {
      wire.bends[segIdx - 1] = {
        x: snapVerticalSegmentX(origins[segIdx - 1].x + dx, snapContext),
        y: origins[segIdx - 1].y,
      };
      wire.bends[segIdx] = {
        x: snapVerticalSegmentX(origins[segIdx].x + dx, snapContext),
        y: origins[segIdx].y,
      };
    }
    return;
  }

  if (dragWire.bendIndex >= 0 && Array.isArray(wire.bends)) {
    const origin = dragWire.origin;
    wire.bends[dragWire.bendIndex] = snapWirePoint({
      x: origin.x + dx,
      y: origin.y + dy,
    }, snapContext);
    return;
  }

  if (dragWire.route === "V") {
    wire.bend = snapHorizontalSegmentY(dragWire.origin + dy, snapContext);
  } else {
    wire.bend = snapVerticalSegmentX(dragWire.origin + dx, snapContext);
  }
}
