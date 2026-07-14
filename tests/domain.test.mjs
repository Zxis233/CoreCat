import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

function makeElementStub() {
  return {
    style: { setProperty() {} },
    classList: { add() {}, remove() {} },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    setAttribute() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 1200, height: 800 };
    },
    clientWidth: 1200,
    clientHeight: 800,
  };
}

globalThis.document = {
  getElementById: makeElementStub,
  createElement: makeElementStub,
  createElementNS: makeElementStub,
  createDocumentFragment: makeElementStub,
};

const { DIAGRAM_LIMITS } = await import("../js/constants.js");
const { state } = await import("../js/state.js");
const { uid } = await import("../js/utils.js");
const { createModule, ensureMuxPorts } = await import("../js/module.js");
const { buildModulePortIndex, getPortByRef } = await import("../js/port.js");
const { addPort, getPortSideOptions, removePort, setModuleType } = await import("../js/property-logic.js");
const { collectWireRenderItems, createWire } = await import("../js/wire.js");

beforeEach(() => {
  state.modules = [];
  state.wires = [];
  state.selection = null;
  state.connecting = null;
  state.typeCounts = {};
  state.nextId = 1;
});

test("uid keeps the prefix and stays unique beyond numeric counter limits", () => {
  state.nextId = Number.MAX_VALUE;
  const ids = new Set(Array.from({ length: 256 }, () => uid("mod")));
  assert.equal(ids.size, 256);
  for (const id of ids) {
    assert.match(id, /^mod-.+/);
  }
});

test("module, wire, and port creation reject capacity overflow", () => {
  state.modules = Array.from({ length: DIAGRAM_LIMITS.modules }, (_, index) => ({ id: `full-${index}` }));
  let selected = false;
  assert.equal(createModule("seq", 0, 0, () => { selected = true; }), null);
  assert.equal(state.modules.length, DIAGRAM_LIMITS.modules);
  assert.equal(selected, false);

  const mod = { id: "ports-full", ports: Array.from({ length: DIAGRAM_LIMITS.portsPerModule }, (_, index) => ({ id: `p-${index}` })) };
  assert.equal(addPort(mod, (prefix) => `${prefix}-extra`), null);
  assert.equal(mod.ports.length, DIAGRAM_LIMITS.portsPerModule);

  state.wires = Array.from({ length: DIAGRAM_LIMITS.wires }, (_, index) => ({ id: `wire-${index}` }));
  assert.equal(createWire({ moduleId: "a", portId: "p" }, { moduleId: "b", portId: "p" }), null);
  assert.equal(state.wires.length, DIAGRAM_LIMITS.wires);
});

test("successful creators return their created domain objects", () => {
  const first = createModule("seq", 10, 20);
  const second = createModule("combo", 300, 20);
  assert.equal(state.modules[0], first);
  assert.equal(state.modules[1], second);

  const wire = createWire(
    { moduleId: first.id, portId: first.ports[0].id },
    { moduleId: second.id, portId: second.ports[0].id }
  );
  assert.equal(state.wires[0], wire);
});

test("generated module names stay unique after counters are rebuilt from imported data", () => {
  state.modules = [{ id: "existing", type: "alu", name: "ALU 2", ports: [] }];
  state.typeCounts = { alu: 1 };
  const created = createModule("alu", 0, 0);
  assert.equal(created.name, "ALU 3");
});

test("switching to mux preserves compatible named ports and their wires", () => {
  const mod = {
    id: "target",
    type: "combo",
    ports: [
      { id: "old-in", name: "InA", side: "left", offset: 0.5 },
      { id: "shared-out", name: "Out", side: "right", offset: 0.5 },
    ],
  };
  state.modules = [mod];
  state.wires = [
    { id: "keep", from: { moduleId: mod.id, portId: "shared-out" }, to: { moduleId: "other", portId: "p" } },
    { id: "drop", from: { moduleId: mod.id, portId: "old-in" }, to: { moduleId: "other", portId: "p" } },
  ];

  assert.equal(setModuleType(mod, "mux"), mod);
  assert.equal(mod.ports.find((port) => port.name === "Out").id, "shared-out");
  assert.deepEqual(state.wires.map((wire) => wire.id), ["keep"]);
  assert.ok(mod.ports.length <= DIAGRAM_LIMITS.portsPerModule);
});

test("switching from mux removes slope sides and dangling related wires", () => {
  const mod = {
    id: "mux-module",
    type: "mux",
    muxInputs: 2,
    muxControlSide: "top",
    ports: [
      { id: "input", name: "I1", side: "left", offset: 0.5 },
      { id: "select", name: "Sel", side: "slopeTop", offset: 0.5 },
      { id: "output", name: "Out", side: "right", offset: 0.5 },
    ],
  };
  state.modules = [mod];
  state.wires = [
    { id: "valid", from: { moduleId: mod.id, portId: "select" }, to: { moduleId: "other", portId: "p" } },
    { id: "dangling", from: { moduleId: mod.id, portId: "missing" }, to: { moduleId: "other", portId: "p" } },
    { id: "unrelated", from: { moduleId: "other", portId: "missing" }, to: { moduleId: "third", portId: "p" } },
  ];

  assert.equal(setModuleType(mod, "seq"), mod);
  assert.equal(mod.ports.some((port) => port.side === "slopeTop" || port.side === "slopeBottom"), false);
  assert.equal(mod.ports.find((port) => port.id === "select").side, "top");
  assert.equal("muxInputs" in mod, false);
  assert.equal("muxControlSide" in mod, false);
  assert.deepEqual(state.wires.map((wire) => wire.id), ["valid", "unrelated"]);
});

test("seq clock ports use shared case-insensitive clock rules", () => {
  const values = getPortSideOptions(
    { type: "seq" },
    { name: "clk", clock: false, side: "left" }
  ).map((option) => option.value);
  assert.deepEqual(values, ["top", "bottom"]);
});

test("removePort only removes wires for the matching module and port pair", () => {
  const mod = { id: "module-a", ports: [{ id: "shared-port" }] };
  const wires = [
    { id: "remove-from", from: { moduleId: "module-a", portId: "shared-port" }, to: { moduleId: "x", portId: "p" } },
    { id: "remove-to", from: { moduleId: "x", portId: "p" }, to: { moduleId: "module-a", portId: "shared-port" } },
    { id: "keep", from: { moduleId: "module-b", portId: "shared-port" }, to: { moduleId: "x", portId: "p" } },
  ];

  assert.deepEqual(removePort(mod, wires, "shared-port").map((wire) => wire.id), ["keep"]);
  assert.deepEqual(mod.ports, []);
});

test("bulk wire collection resolves endpoints through one module/port index", () => {
  state.modules = [
    { id: "a", x: 10, y: 20, width: 100, height: 80, ports: [{ id: "out", side: "right", offset: 0.5 }] },
    { id: "b", x: 300, y: 20, width: 100, height: 80, ports: [{ id: "in", side: "left", offset: 0.5 }] },
  ];
  state.wires = [
    { id: "valid", from: { moduleId: "a", portId: "out" }, to: { moduleId: "b", portId: "in" }, route: "H", bend: 200 },
    { id: "invalid", from: { moduleId: "a", portId: "missing" }, to: { moduleId: "b", portId: "in" }, route: "H", bend: 200 },
  ];

  const index = buildModulePortIndex();
  assert.equal(getPortByRef({ moduleId: "a", portId: "out" }, index).port.id, "out");
  assert.deepEqual(collectWireRenderItems().renderItems.map((item) => item.wire.id), ["valid"]);
});

test("ensureMuxPorts always leaves the module within port capacity", () => {
  const mod = {
    id: "mux",
    type: "mux",
    muxInputs: Number.MAX_SAFE_INTEGER,
    ports: Array.from({ length: DIAGRAM_LIMITS.portsPerModule + 10 }, (_, index) => ({
      id: `old-${index}`,
      name: `Old${index}`,
      side: "left",
      offset: 0.5,
    })),
  };
  const ports = ensureMuxPorts(mod);
  assert.equal(ports, mod.ports);
  assert.ok(ports.length <= DIAGRAM_LIMITS.portsPerModule);
});
