/**
 * Interaction logic - drag state updates without DOM work.
 */

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

  if (dragWire.segmentIndex !== undefined && Array.isArray(wire.bends)) {
    const segIdx = dragWire.segmentIndex;
    const isHorizontal = dragWire.isHorizontal;
    const origins = dragWire.origin;
    const numBends = wire.bends.length;

    if (isHorizontal) {
      if (segIdx === 0) {
        wire.bends[0] = {
          x: origins[0].x,
          y: Math.round(origins[0].y + dy),
        };
      } else if (segIdx === numBends) {
        wire.bends[numBends - 1] = {
          x: origins[numBends - 1].x,
          y: Math.round(origins[numBends - 1].y + dy),
        };
      } else {
        wire.bends[segIdx - 1] = {
          x: origins[segIdx - 1].x,
          y: Math.round(origins[segIdx - 1].y + dy),
        };
        wire.bends[segIdx] = {
          x: origins[segIdx].x,
          y: Math.round(origins[segIdx].y + dy),
        };
      }
    } else if (segIdx === 0) {
      wire.bends[0] = {
        x: Math.round(origins[0].x + dx),
        y: origins[0].y,
      };
    } else if (segIdx === numBends) {
      wire.bends[numBends - 1] = {
        x: Math.round(origins[numBends - 1].x + dx),
        y: origins[numBends - 1].y,
      };
    } else {
      wire.bends[segIdx - 1] = {
        x: Math.round(origins[segIdx - 1].x + dx),
        y: origins[segIdx - 1].y,
      };
      wire.bends[segIdx] = {
        x: Math.round(origins[segIdx].x + dx),
        y: origins[segIdx].y,
      };
    }
    return;
  }

  if (dragWire.bendIndex >= 0 && Array.isArray(wire.bends)) {
    const origin = dragWire.origin;
    wire.bends[dragWire.bendIndex] = {
      x: Math.round(origin.x + dx),
      y: Math.round(origin.y + dy),
    };
    return;
  }

  if (dragWire.route === "V") {
    wire.bend = Math.round(dragWire.origin + dy);
  } else {
    wire.bend = Math.round(dragWire.origin + dx);
  }
}
