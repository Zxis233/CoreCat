/** Pure orthogonal routing. Coordinates stay exact; only free drag axes snap. */
import { DIAGRAM_LIMITS, WIRE_MARGIN } from './constants.js';

export function routeMode(wire) {
  return ['simple', 'auto', 'manual'].includes(wire.routingMode)
    ? wire.routingMode : (Array.isArray(wire.bends) && wire.bends.length ? 'manual' : 'simple');
}

export function portDirection(side) {
  if (side === 'left') return { x: -1, y: 0 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'top' || side === 'slopeTop') return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

export function simplifyRoute(points) {
  const result = [];
  for (const p of points) {
    const b = result.at(-1);
    if (b && b.x === p.x && b.y === p.y) continue;
    const a = result.at(-2);
    // Only remove same-direction collinear points, never erase a U-turn.
    if (a && ((a.x === b.x && b.x === p.x && (b.y - a.y) * (p.y - b.y) > 0)
      || (a.y === b.y && b.y === p.y && (b.x - a.x) * (p.x - b.x) > 0))) result.pop();
    result.push({ x: p.x, y: p.y });
  }
  return result;
}

export function routeObstacles(context) {
  return context.modules.map(mod => {
    const margin = WIRE_MARGIN + (context.width || 2.5) / 2 + (mod.strokeWidth || 0) / 2;
    return { id: mod.id, left: mod.x - margin, right: mod.x + mod.width + margin,
      top: mod.y - margin, bottom: mod.y + mod.height + margin };
  });
}

export function segmentHitsRect(a, b, r) {
  if (a.x === b.x && a.y === b.y) return false;
  if (a.y === b.y) return a.y > r.top && a.y < r.bottom
    && Math.max(a.x, b.x) > r.left && Math.min(a.x, b.x) < r.right;
  if (a.x === b.x) return a.x > r.left && a.x < r.right
    && Math.max(a.y, b.y) > r.top && Math.min(a.y, b.y) < r.bottom;
  return true;
}

function outward(a, b, side) {
  const d = portDirection(side);
  return d.x ? a.y === b.y && (b.x - a.x) * d.x > 0
    : a.x === b.x && (b.y - a.y) * d.y > 0;
}

export function validateRoute(points, context, obstacles = routeObstacles(context)) {
  const p = simplifyRoute(points);
  if (p.length < 2 || p.some(v => !Number.isFinite(v.x) || !Number.isFinite(v.y))) return false;
  if (p[0].x !== context.start.x || p[0].y !== context.start.y
    || p.at(-1).x !== context.end.x || p.at(-1).y !== context.end.y) return false;
  if (!outward(p[0], p[1], context.fromSide)
    || !outward(p.at(-1), p.at(-2), context.toSide)) return false;
  for (let i = 1; i < p.length; i++) {
    if (p[i - 1].x !== p[i].x && p[i - 1].y !== p[i].y) return false;
    for (const r of obstacles) {
      // Only the actual terminal segments may cross their own clearance zone.
      if ((i === 1 && r.id === context.fromId) || (i === p.length - 1 && r.id === context.toId)) continue;
      if (segmentHitsRect(p[i - 1], p[i], r)) return false;
    }
  }
  return true;
}

function escapePoint(point, side, rect) {
  const d = portDirection(side);
  if (!rect) return { x: point.x + d.x * WIRE_MARGIN, y: point.y + d.y * WIRE_MARGIN };
  return { x: d.x < 0 ? rect.left : d.x > 0 ? rect.right : point.x,
    y: d.y < 0 ? rect.top : d.y > 0 ? rect.bottom : point.y };
}

export function moveRouteSegment(points, index, value, context) {
  if (!Number.isFinite(value) || index < 1 || index >= points.length - 2) return null;
  const p = points.map(point => ({ ...point }));
  const a = p[index], b = p[index + 1];
  const axis = a.y === b.y ? 'y' : a.x === b.x ? 'x' : null;
  if (!axis || (a.x === b.x && a.y === b.y)) return null;
  let min = -Infinity, max = Infinity;
  const obstacles = routeObstacles(context);
  for (const [terminal, side, id, adjacent] of [
    [context.start, context.fromSide, context.fromId, index === 1],
    [context.end, context.toSide, context.toId, index === points.length - 3],
  ]) {
    if (!adjacent) continue;
    const d = portDirection(side), escape = escapePoint(terminal, side, obstacles.find(r => r.id === id));
    if (d[axis] > 0) min = Math.max(min, escape[axis]);
    if (d[axis] < 0) max = Math.min(max, escape[axis]);
  }
  if (min > max) return null;
  a[axis] = b[axis] = Math.max(min, Math.min(max, value));
  if (p.some((q, i) => i && q.x !== p[i - 1].x && q.y !== p[i - 1].y)) return null;
  return p;
}

/** Preserve the interior of a manual route while reconnecting its terminals. */
export function repairRoute(points, context) {
  const old = simplifyRoute(points);
  const obstacles = routeObstacles(context);
  const startEscape = escapePoint(context.start, context.fromSide, obstacles.find(r => r.id === context.fromId));
  const endEscape = escapePoint(context.end, context.toSide, obstacles.find(r => r.id === context.toId));
  const bends = old.slice(1, -1).map(p => ({ ...p }));
  if (bends.length < 2) {
    const middle = portDirection(context.fromSide).x
      ? { x: startEscape.x, y: endEscape.y } : { x: endEscape.x, y: startEscape.y };
    return simplifyRoute([context.start, startEscape, middle, endEscape, context.end]);
  }
  const align = (bend, point, escape, side) => {
    const d = portDirection(side);
    if (d.x) { bend.y = point.y; bend.x = d.x > 0 ? Math.max(bend.x, escape.x) : Math.min(bend.x, escape.x); }
    else { bend.x = point.x; bend.y = d.y > 0 ? Math.max(bend.y, escape.y) : Math.min(bend.y, escape.y); }
  };
  align(bends[0], context.start, startEscape, context.fromSide);
  align(bends.at(-1), context.end, endEscape, context.toSide);
  const result = [context.start];
  for (let i = 0; i < bends.length; i++) {
    const a = result.at(-1), b = bends[i];
    if (a.x !== b.x && a.y !== b.y) {
      // Preserve the original segment axis where possible.
      const originalA = old[i], originalB = old[i + 1];
      result.push(originalA.x === originalB.x ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
    }
    result.push(b);
  }
  result.push(context.end);
  return simplifyRoute(result);
}

function length(points) {
  return points.slice(1).reduce((n, p, i) => n + Math.abs(p.x - points[i].x) + Math.abs(p.y - points[i].y), 0);
}

/** Bounded candidate routing, followed by an orthogonal grid search if needed. */
export function findSmartRoute(context) {
  const obstacles = routeObstacles(context);
  const a = escapePoint(context.start, context.fromSide, obstacles.find(r => r.id === context.fromId));
  const b = escapePoint(context.end, context.toSide, obstacles.find(r => r.id === context.toId));
  const clear = (p, q) => !obstacles.some(r => segmentHitsRect(p, q, r));
  const wrap = middle => simplifyRoute([context.start, ...middle, context.end]);
  const xs = [...new Set([a.x, b.x, ...obstacles.flatMap(r => [r.left, r.right])])].sort((x, y) => x - y);
  const ys = [...new Set([a.y, b.y, ...obstacles.flatMap(r => [r.top, r.bottom])])].sort((x, y) => x - y);
  let best = null, score = Infinity;
  const consider = middle => {
    const p = wrap(middle);
    if (p.length - 2 > DIAGRAM_LIMITS.bendsPerWire || !validateRoute(p, context, obstacles)) return;
    const cost = length(p) + (p.length - 2) * 24;
    if (cost < score) { best = p; score = cost; }
  };
  consider([]);
  consider([a, b]);
  consider([a, { x: b.x, y: a.y }, b]);
  consider([a, { x: a.x, y: b.y }, b]);
  // Budget candidate work before constructing a potentially large grid.
  const near = (values, v, w) => values.sort((x, y) => Math.abs(x - v) + Math.abs(x - w) - Math.abs(y - v) - Math.abs(y - w)).slice(0, 128);
  for (const x of near([...xs], a.x, b.x)) consider([a, { x, y: a.y }, { x, y: b.y }, b]);
  for (const y of near([...ys], a.y, b.y)) consider([a, { x: a.x, y }, { x: b.x, y }, b]);
  if (best) return { ok: true, points: best };
  if (!clear(context.start, a) && obstacles.some(r => r.id !== context.fromId && segmentHitsRect(context.start, a, r)))
    return { ok: false, reason: 'Port exit is blocked at the current clearance.' };
  if (xs.length * ys.length > 16000 || obstacles.length > 256)
    return { ok: false, reason: 'Route search budget exceeded. Adjust the layout or use Manual route.' };

  // Search state includes the incoming axis, so bends have a real cost.
  const heap = [];
  const push = item => { heap.push(item); let i = heap.length - 1; while (i > 0) {
    const parent = (i - 1) >> 1; if (heap[parent].f <= item.f) break;
    heap[i] = heap[parent]; i = parent;
  } heap[i] = item; };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) {
    let i = 0; while (i * 2 + 1 < heap.length) { let c = i * 2 + 1;
      if (c + 1 < heap.length && heap[c + 1].f < heap[c].f) c++;
      if (heap[c].f >= last.f) break; heap[i] = heap[c]; i = c;
    } heap[i] = last;
  } return top; };
  const key = (x, y, axis, turns) => `${x}:${y}:${axis}:${turns}`;
  const heuristic = p => Math.abs(p.x - b.x) + Math.abs(p.y - b.y);
  const start = { x: xs.indexOf(a.x), y: ys.indexOf(a.y), axis: portDirection(context.fromSide).x ? 0 : 1, turns: 0, g: 0, p: a, parent: null };
  start.f = heuristic(a);
  const costs = new Map([[key(start.x, start.y, start.axis, 0), 0]]);
  push(start);
  let count = 0;
  while (heap.length && count++ < 40000) {
    const curr = pop();
    if (curr.g !== costs.get(key(curr.x, curr.y, curr.axis, curr.turns))) continue;
    if (curr.p.x === b.x && curr.p.y === b.y) {
      const middle = []; for (let item = curr; item; item = item.parent) middle.push(item.p);
      const points = wrap(middle.reverse());
      if (points.length - 2 <= DIAGRAM_LIMITS.bendsPerWire && validateRoute(points, context, obstacles)) return { ok: true, points };
      continue;
    }
    for (const [dx, dy, axis] of [[-1, 0, 0], [1, 0, 0], [0, -1, 1], [0, 1, 1]]) {
      const x = curr.x + dx, y = curr.y + dy;
      if (x < 0 || x >= xs.length || y < 0 || y >= ys.length) continue;
      const p = { x: xs[x], y: ys[y] };
      if (!clear(curr.p, p)) continue;
      const turns = curr.turns + (axis === curr.axis ? 0 : 1);
      if (turns > DIAGRAM_LIMITS.bendsPerWire) continue;
      const g = curr.g + Math.abs(p.x - curr.p.x) + Math.abs(p.y - curr.p.y) + (axis === curr.axis ? 0 : 24);
      const id = key(x, y, axis, turns);
      if (g >= (costs.get(id) ?? Infinity)) continue;
      costs.set(id, g); push({ x, y, axis, turns, p, g, f: g + heuristic(p), parent: curr });
    }
  }
  return { ok: false, reason: heap.length ? 'Route search budget exceeded.' : 'No route found within the current clearance and bend-point limit.' };
}
