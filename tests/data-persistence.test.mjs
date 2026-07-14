import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function createStyle() {
  return {
    background: "",
    setProperty(name, value) {
      this[name] = value;
    },
  };
}

function createElement(id = "") {
  return {
    id,
    style: createStyle(),
    classList: { add() {}, remove() {} },
    clientWidth: 800,
    clientHeight: 600,
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
    },
  };
}

const elements = new Map();
globalThis.document = {
  body: createElement("body"),
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, createElement(id));
    }
    return elements.get(id);
  },
  createElement(tag) {
    return createElement(tag);
  },
  createElementNS(_namespace, tag) {
    return createElement(tag);
  },
};
globalThis.window = {
  devicePixelRatio: 1,
  setTimeout,
  clearTimeout,
};
globalThis.alert = () => {};

const { state, canvas } = await import("../js/state.js");
const { DIAGRAM_LIMITS } = await import("../js/constants.js");
const {
  DIAGRAM_SCHEMA_VERSION,
  exportPng,
  flushAutoSave,
  loadDiagramFromStorage,
  normalizeDiagram,
  refreshIdCounter,
  saveDiagramToStorage,
  serializeState,
} = await import("../js/export.js");
const {
  initHistory,
  recordHistory,
  undoHistory,
} = await import("../js/history.js");

function makeModule(overrides = {}) {
  return {
    id: "mod-1",
    type: "combo",
    name: "Module",
    x: 0,
    y: 0,
    width: 120,
    height: 80,
    nameSize: 14,
    showType: false,
    fill: "",
    strokeColor: "",
    strokeWidth: 2,
    ports: [
      { id: "port-1", name: "clock_in", side: "left", offset: 0.25, clock: true },
      { id: "port-2", name: "Out", side: "right", offset: 0.5 },
    ],
    ...overrides,
  };
}

function makeWire(overrides = {}) {
  return {
    id: "wire-1",
    from: { moduleId: "mod-1", portId: "port-1" },
    to: { moduleId: "mod-1", portId: "port-2" },
    label: "",
    labelAt: "end",
    route: "H",
    bend: 40,
    bends: [{ x: 10, y: 20 }],
    color: "#263238",
    width: 2.5,
    style: "solid",
    ...overrides,
  };
}

function resetState() {
  state.modules = [];
  state.wires = [];
  state.selection = null;
  state.connecting = null;
  state.drag = null;
  state.dragWire = null;
  state.pan = null;
  state.nextId = 1;
  state.typeCounts = {};
  state.canvasBackground = "";
  state.portLabelSize = 14;
  state.wireSnapMode = "grid-port";
  state.export.transparent = true;
  state.export.fitToBounds = true;
  canvas.clientWidth = 800;
  canvas.clientHeight = 600;
}

test("serializeState emits schema v1, preserves clock, and detaches wire geometry", () => {
  resetState();
  state.modules = [makeModule()];
  state.wires = [makeWire()];

  const serialized = serializeState();
  assert.equal(serialized.schemaVersion, DIAGRAM_SCHEMA_VERSION);
  assert.equal(serialized.modules[0].ports[0].clock, true);
  assert.notStrictEqual(serialized.wires[0].from, state.wires[0].from);
  assert.notStrictEqual(serialized.wires[0].to, state.wires[0].to);
  assert.notStrictEqual(serialized.wires[0].bends, state.wires[0].bends);
  assert.notStrictEqual(serialized.wires[0].bends[0], state.wires[0].bends[0]);

  state.wires[0].from.moduleId = "changed";
  state.wires[0].bends[0].x = 99;
  assert.equal(serialized.wires[0].from.moduleId, "mod-1");
  assert.equal(serialized.wires[0].bends[0].x, 10);
});

test("normalization accepts unversioned v0 and rejects unknown future schemas", () => {
  const v0 = normalizeDiagram({ modules: [], wires: [] });
  assert.equal(v0.ok, true);
  assert.equal(v0.diagram.schemaVersion, DIAGRAM_SCHEMA_VERSION);

  const v1 = normalizeDiagram({ schemaVersion: DIAGRAM_SCHEMA_VERSION, modules: [], wires: [] });
  assert.equal(v1.ok, true);

  const future = normalizeDiagram({ schemaVersion: DIAGRAM_SCHEMA_VERSION + 1, modules: [], wires: [] });
  assert.equal(future.ok, false);
  assert.match(future.errors[0], /newer than supported/i);
});

test("full-diagram normalization rejects capacity overflow instead of truncating data", () => {
  const tooManyModules = normalizeDiagram({
    modules: Array.from({ length: DIAGRAM_LIMITS.modules + 1 }, () => ({})),
    wires: [],
  });
  assert.equal(tooManyModules.ok, false);
  assert.match(tooManyModules.errors[0], /module limit/i);

  const oversizedPorts = normalizeDiagram({
    modules: [makeModule({
      ports: Array.from({ length: DIAGRAM_LIMITS.portsPerModule + 1 }, (_, index) => ({
        id: `port-${index}`,
        name: `P${index}`,
        side: "left",
        offset: 0.5,
      })),
    })],
    wires: [],
  });
  assert.equal(oversizedPorts.ok, false);
  assert.match(oversizedPorts.errors[0], /port limit/i);
});

test("bundled v0 examples remain importable", async () => {
  for (const filename of ["escuterv.json", "LFSR.json"]) {
    const raw = await readFile(new URL(`../examples/${filename}`, import.meta.url), "utf8");
    const normalized = normalizeDiagram(JSON.parse(raw));
    assert.equal(normalized.ok, true, `${filename}: ${normalized.errors.join(", ")}`);
  }
});

test("overlong imported labels are truncated with a visible warning payload", () => {
  const normalized = normalizeDiagram({
    modules: [makeModule({ name: "M".repeat(DIAGRAM_LIMITS.textLength + 1) })],
    wires: [],
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.diagram.modules[0].name.length, DIAGRAM_LIMITS.textLength);
  assert.equal(normalized.warnings.some((warning) => /truncated/i.test(warning)), true);
});

test("refreshIdCounter ignores unsafe suffixes and never overflows", () => {
  resetState();
  state.modules = [
    makeModule({ id: "mod-7", ports: [] }),
    makeModule({ id: "mod-9007199254740992", ports: [] }),
  ];
  refreshIdCounter();
  assert.equal(state.nextId, 8);

  state.modules = [
    makeModule({ id: `mod-${Number.MAX_SAFE_INTEGER}`, ports: [] }),
    makeModule({ id: "mod-1", ports: [] }),
  ];
  refreshIdCounter();
  assert.equal(state.nextId, 2);
  assert.equal(Number.isSafeInteger(state.nextId), true);
});

test("leaving after a failed restore does not overwrite the original stored data", () => {
  resetState();
  const futureDiagram = JSON.stringify({
    schemaVersion: DIAGRAM_SCHEMA_VERSION + 1,
    modules: [{ id: "future-module" }],
    wires: [],
  });
  let storedValue = futureDiagram;
  globalThis.localStorage = {
    getItem() {
      return storedValue;
    },
    setItem(_key, value) {
      storedValue = value;
    },
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(loadDiagramFromStorage(), false);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(flushAutoSave(), { ok: true, skipped: true });
  assert.equal(storedValue, futureDiagram);
});

test("saveDiagramToStorage reports success and failure explicitly", () => {
  resetState();
  let savedValue = "";
  globalThis.localStorage = {
    setItem(_key, value) {
      savedValue = value;
    },
  };
  assert.deepEqual(saveDiagramToStorage(), { ok: true });
  assert.equal(JSON.parse(savedValue).schemaVersion, DIAGRAM_SCHEMA_VERSION);

  const storageError = new Error("quota exceeded");
  globalThis.localStorage = {
    setItem() {
      throw storageError;
    },
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = saveDiagramToStorage();
    assert.equal(result.ok, false);
    assert.strictEqual(result.error, storageError);
  } finally {
    console.error = originalConsoleError;
  }
});

test("history snapshots keep smart bends independent from live state", () => {
  resetState();
  state.modules = [makeModule()];
  state.wires = [makeWire()];
  initHistory();

  state.wires[0].bends[0].x = 99;
  recordHistory();
  assert.equal(undoHistory(), true);
  assert.equal(state.wires[0].bends[0].x, 10);
});

test("history clears restoring guard even when a render callback throws", () => {
  resetState();
  state.modules = [makeModule()];
  initHistory();
  state.modules[0].x = 20;
  recordHistory();

  assert.throws(
    () => undoHistory({
      renderModules() {
        throw new Error("render failed");
      },
      updateWires() {},
      renderProperties() {},
      updateStatus() {},
    }),
    /render failed/
  );

  state.modules[0].x = 30;
  recordHistory();
  assert.equal(undoHistory(), true);
  assert.equal(state.modules[0].x, 0);
});

test("PNG export rejects oversized raster dimensions before allocation", () => {
  resetState();
  canvas.clientWidth = 9000;
  canvas.clientHeight = 100;
  let alertMessage = "";
  const originalAlert = globalThis.alert;
  globalThis.alert = (message) => {
    alertMessage = message;
  };
  try {
    assert.equal(exportPng(), false);
    assert.match(alertMessage, /too large/i);

    canvas.clientWidth = 5000;
    canvas.clientHeight = 5000;
    alertMessage = "";
    assert.equal(exportPng(), false);
    assert.match(alertMessage, /too large/i);
  } finally {
    globalThis.alert = originalAlert;
  }
});
