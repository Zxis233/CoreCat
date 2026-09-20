import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const element = () => ({ style: { setProperty() {} }, classList: { add() {}, remove() {} },
  setAttribute() {}, addEventListener() {}, appendChild() {}, clientWidth: 1200, clientHeight: 800 });
globalThis.document = { getElementById: element, createElement: element, createElementNS: element };
const { state } = await import('../js/state.js');
const { findSmartRoute, validateRoute, simplifyRoute, repairRoute, routeMode, moveRouteSegment } = await import('../js/wire-routing.js');
const { getWirePathPoints, getWireHandlePositions, buildWirePath } = await import('../js/wire-geometry.js');
const { createWire, setWireSmartBends, getWireRouteContext, maintainWireRoutes, rememberWireRoutes,
  captureWireRoutes, restoreWireRoutes, finishWireEdit, editWireSegment } = await import('../js/wire.js');
const { updateWireDragGeometry } = await import('../js/interaction-logic.js');
const { serializeState, loadState } = await import('../js/export.js');
const { normalizeDiagram, DIAGRAM_SCHEMA_VERSION } = await import('../js/diagram-normalize.js');
const { initHistory, recordHistory, undoHistory, redoHistory } = await import('../js/history.js');
const { recomputeWireSmartRoute, setWireRoute } = await import('../js/property-logic.js');

function mod(id, x, y, side = 'right', width = 100, height = 101) {
  return { id, x, y, width, height, type: 'combo', name: id, strokeWidth: 1,
    ports: [{ id: `${id}-p`, name: 'p', side, offset: 0.5 }] };
}
function scene({ obstacle = true, fromSide = 'right', toSide = 'left' } = {}) {
  const a = mod('a', 0, 0, fromSide), c = mod('c', 500, 0, toSide);
  state.modules = [a, c];
  if (obstacle) state.modules.push(mod('b', 250, -30, 'right', 100, 170));
  const wire = createWire({ moduleId: 'a', portId: 'a-p' }, { moduleId: 'c', portId: 'c-p' });
  rememberWireRoutes();
  return { a, c, wire, context: getWireRouteContext(wire) };
}
const points = wire => { const c = getWireRouteContext(wire); return getWirePathPoints(wire, c.start, c.end); };
function orthogonal(p) {
  assert.ok(p.every((q, i) => !i || q.x === p[i - 1].x || q.y === p[i - 1].y), JSON.stringify(p));
}

beforeEach(() => { state.modules = []; state.wires = []; state.nextId = 1; state.typeCounts = {}; });

test('opposed fractional ports connect directly and retain Auto even with no bends', () => {
  const { wire } = scene({ obstacle: false });
  assert.equal(setWireSmartBends(wire).ok, true);
  assert.deepEqual(wire.bends, []);
  assert.equal(routeMode(wire), 'auto');
  assert.equal(points(wire)[0].y, 50.5);
  assert.equal(getWireHandlePositions(wire, ...[getWireRouteContext(wire).start, getWireRouteContext(wire).end]).length, 0);
  assert.ok(validateRoute(points(wire), getWireRouteContext(wire)));
});

test('A-B-C routes through both local gaps with a five-segment detour', () => {
  const { wire } = scene();
  assert.equal(setWireSmartBends(wire).ok, true);
  const p = points(wire);
  assert.equal(p.length, 6);
  assert.ok(p[1].x > 100 && p[1].x < 250);
  assert.ok(p.at(-2).x > 350 && p.at(-2).x < 500);
  assert.ok(validateRoute(p, getWireRouteContext(wire)));
  orthogonal(p);
});

test('all endpoint side combinations, including MUX slopes, respect outward directions', () => {
  for (const fromSide of ['left', 'right', 'top', 'bottom', 'slopeTop', 'slopeBottom']) {
    for (const toSide of ['left', 'right', 'top', 'bottom', 'slopeTop', 'slopeBottom']) {
      state.wires = [];
      const { wire } = scene({ obstacle: true, fromSide, toSide });
      const result = setWireSmartBends(wire);
      assert.equal(result.ok, true, `${fromSide} -> ${toSide}: ${result.reason}`);
      assert.ok(validateRoute(points(wire), getWireRouteContext(wire)), `${fromSide} -> ${toSide}`);
    }
  }
});

test('same-module self connection goes around its own bounds', () => {
  const a = mod('a', 0, 0);
  a.ports.push({ id: 'left', name: 'left', side: 'left', offset: 0.5 });
  state.modules = [a];
  const wire = createWire({ moduleId: 'a', portId: 'a-p' }, { moduleId: 'a', portId: 'left' });
  assert.equal(setWireSmartBends(wire).ok, true);
  assert.ok(validateRoute(points(wire), getWireRouteContext(wire)));
});

test('failed explicit reroute preserves old geometry and mode', () => {
  const { wire } = scene();
  setWireSmartBends(wire);
  wire.routingMode = 'manual';
  const saved = JSON.stringify(wire.bends);
  state.modules.push(mod('blocked', 90, 20, 'right', 100, 60));
  assert.equal(recomputeWireSmartRoute(wire).ok, false);
  assert.equal(JSON.stringify(wire.bends), saved);
  assert.equal(wire.routingMode, 'manual');
  assert.ok(wire.routeWarning);
});

test('Smart validates detours against obstacles outside the endpoint rectangle', () => {
  const { wire } = scene();
  state.modules.push(mod('upper', 80, -160, 'right', 460, 100));
  assert.equal(setWireSmartBends(wire).ok, true);
  assert.ok(validateRoute(points(wire), getWireRouteContext(wire)));
  assert.ok(points(wire).some(p => p.y > 140));
});

test('internal drag is orthogonal and terminal drag cannot change the wire', () => {
  const { wire } = scene();
  setWireSmartBends(wire);
  const original = structuredClone(wire.bends), context = getWireRouteContext(wire);
  const drag = { startX: 0, startY: 0, origin: original, routeContext: context,
    segmentIndex: 0, isHorizontal: true, snapContext: { mode: 'none' } };
  updateWireDragGeometry(wire, drag, 0, 40, 1);
  assert.deepEqual(wire.bends, original);
  drag.segmentIndex = 2;
  updateWireDragGeometry(wire, drag, 0, 40, 1);
  assert.equal(wire.routingMode, 'manual');
  orthogonal(points(wire));
  assert.equal(wire.bends[0].y, context.start.y);
  assert.equal(wire.bends.at(-1).y, context.end.y);
});

test('side-segment edits cannot reverse terminal direction or cut its clearance', () => {
  const { wire } = scene();
  setWireSmartBends(wire);
  assert.equal(editWireSegment(wire, 1, -1000), true);
  assert.ok(wire.bends[0].x > 100);
  assert.ok(validateRoute(points(wire), getWireRouteContext(wire)));
});

test('module movement repairs Manual endpoints while retaining the interior detour', () => {
  const { wire, a, c } = scene();
  setWireSmartBends(wire);
  wire.routingMode = 'manual';
  const interior = structuredClone(wire.bends.slice(1, -1));
  a.y += 25.25; c.y -= 35.5;
  maintainWireRoutes();
  orthogonal(points(wire));
  for (const p of interior) assert.ok(wire.bends.some(q => q.x === p.x && q.y === p.y));
  assert.equal(wire.routingMode, 'manual');
});

test('moving a non-endpoint obstacle invalidates Auto and leaves legal routes stable', () => {
  const { wire } = scene({ obstacle: false });
  setWireSmartBends(wire);
  state.modules.push(mod('b', 250, -20, 'right', 100, 160));
  maintainWireRoutes();
  assert.ok(wire.bends.length > 0);
  assert.ok(validateRoute(points(wire), getWireRouteContext(wire)));
  const before = structuredClone(wire.bends);
  state.modules.push(mod('far', 10000, 10000));
  maintainWireRoutes();
  assert.deepEqual(wire.bends, before);
});

test('cancellation snapshots restore wire mode, geometry and warning together', () => {
  const { wire, a } = scene();
  setWireSmartBends(wire);
  const before = serializeState(), saved = captureWireRoutes();
  a.y += 90;
  maintainWireRoutes({ reroute: false, moduleId: a.id });
  wire.routingMode = 'manual';
  a.y -= 90;
  restoreWireRoutes(saved);
  assert.deepEqual(serializeState(), before);
});

test('v0/v1 migrate conservatively; v2 fractions and Auto straight paths round-trip', () => {
  const { wire, a } = scene({ obstacle: false });
  a.x = 0.25;
  setWireSmartBends(wire);
  const data = serializeState();
  assert.equal(data.schemaVersion, DIAGRAM_SCHEMA_VERSION);
  assert.equal(loadState(data), true);
  const roundTrip = serializeState();
  assert.equal(loadState(roundTrip), true);
  assert.deepEqual(serializeState(), roundTrip);
  assert.equal(state.modules[0].x, 0.25);
  assert.equal(state.wires[0].routingMode, 'auto');
  for (const version of [0, 1]) {
    const legacy = structuredClone(data);
    legacy.schemaVersion = version;
    delete legacy.wires[0].routingMode;
    legacy.wires[0].bends = [{ x: 140.25, y: 50.5 }, { x: 140.25, y: 150.5 }];
    const normalized = normalizeDiagram(legacy);
    assert.equal(normalized.ok, true);
    assert.equal(normalized.diagram.wires[0].routingMode, 'manual');
    assert.equal(normalized.diagram.wires[0].bends[0].x, 140.25);
  }
});

test('undo and redo restore stored routes without new search', () => {
  const { wire, a } = scene();
  setWireSmartBends(wire);
  // Normalize defaults before comparing full snapshots.
  loadState(serializeState());
  initHistory();
  const before = serializeState();
  state.modules.find(m => m.id === a.id).y += 40.5;
  maintainWireRoutes();
  recordHistory();
  const after = serializeState();
  assert.equal(undoHistory(), true);
  assert.deepEqual(serializeState(), before);
  assert.equal(redoHistory(), true);
  assert.deepEqual(serializeState(), after);
});

test('H/V changes do not erase a Manual route', () => {
  const { wire } = scene();
  setWireSmartBends(wire); wire.routingMode = 'manual';
  const old = structuredClone(wire);
  setWireRoute(wire, 'V');
  assert.deepEqual(wire, old);
});

test('simplification drops zero lengths but retains deliberate backtracking', () => {
  const p = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 5, y: 0 }];
  assert.deepEqual(simplifyRoute(p), [p[0], p[3], p[4]]);
  assert.equal(buildWirePath({ route: 'H', bend: 20 }, p[0], p[4]), 'M 0 0 L 20 0 L 5 0');
});

test('EsCute legacy manual routing survives loading without global rearrangement', async () => {
  const raw = JSON.parse(await readFile(new URL('../examples/escuterv.json', import.meta.url), 'utf8'));
  assert.equal(loadState(raw), true);
  const before = serializeState();
  maintainWireRoutes();
  assert.deepEqual(serializeState(), before);
  assert.ok(state.wires.every(w => routeMode(w) !== 'auto'));
});

test('inconsistent and corrupt imported modes fall back without producing diagonal empty routes', () => {
  const { wire, c } = scene({ obstacle: false });
  c.y = 40;
  const data = serializeState();
  for (const [mode, bends, expected] of [
    ['simple', [{ x: 150, y: 50.5 }, { x: 150, y: 90.5 }], 'manual'],
    ['auto', null, 'simple'],
    ['manual', [{ x: 'bad', y: 10 }], 'simple'],
    ['manual', [], 'simple'],
    ['auto', [], 'simple'],
  ]) {
    data.wires[0].routingMode = mode; data.wires[0].bends = bends;
    const result = normalizeDiagram(data);
    assert.equal(result.ok, true);
    assert.equal(result.diagram.wires[0].routingMode, expected);
    assert.ok(result.warnings.length > 0);
    loadState(result.diagram);
    orthogonal(points(state.wires[0]));
  }
});

test('endpoint repair at the bend limit rolls back the geometry edit atomically', () => {
  const { wire, a } = scene({ obstacle: false });
  wire.routingMode = 'manual'; wire.bends = [];
  let y = 50.5;
  for (let i = 0; i < 32; i++) {
    const x = 140 + i * 8;
    wire.bends.push({ x, y });
    y = i === 31 ? 50.5 : (i % 2 ? 180 : 160);
    wire.bends.push({ x, y });
  }
  rememberWireRoutes();
  const original = structuredClone(wire.bends);
  a.x = 100;
  assert.equal(maintainWireRoutes(), false);
  assert.equal(a.x, 0);
  assert.deepEqual(wire.bends, original);
  orthogonal(points(wire));
  assert.match(wire.routeWarning, /limit/);
});

test('grid search finds a route when port columns block all simple detour candidates', () => {
  const { wire, c } = scene({ obstacle: false });
  c.x = 1000;
  state.modules.push(mod('top', 110, -160, 'right', 100, 150),
    mod('bottom', 110, 110, 'right', 100, 150),
    mod('middle', 450, -80, 'right', 120, 260));
  const result = setWireSmartBends(wire);
  assert.equal(result.ok, true, result.reason);
  assert.ok(validateRoute(points(wire), getWireRouteContext(wire)));
  assert.ok(points(wire)[1].x > 210, 'Search should move the first turn beyond the blocked port column.');
});

test('pagehide cancels an unfinished module gesture before saving its routes', async () => {
  const { wire, a } = scene();
  setWireSmartBends(wire);
  const before = JSON.parse(JSON.stringify(serializeState()));
  const snapshot = captureWireRoutes();
  state.drag = { id: a.id, initialX: a.x, initialY: a.y, wireSnapshot: snapshot };
  a.y += 80;
  maintainWireRoutes({ reroute: false, moduleId: a.id });
  const oldWindow = globalThis.window, oldStorage = globalThis.localStorage;
  let saved;
  globalThis.window = new EventTarget();
  globalThis.localStorage = { setItem(key, value) { saved = JSON.parse(value); } };
  try {
    const { initWindowEvents } = await import('../js/events.js');
    initWindowEvents();
    window.dispatchEvent(new Event('pagehide'));
    assert.equal(state.drag, null);
    assert.deepEqual(saved, before);
  } finally {
    globalThis.window = oldWindow;
    globalThis.localStorage = oldStorage;
  }
});
