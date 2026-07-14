import test from "node:test";
import assert from "node:assert/strict";

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  setFromString(value) {
    this.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  add(...values) {
    values.forEach((value) => this.values.add(value));
  }

  remove(...values) {
    values.forEach((value) => this.values.delete(value));
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.children = [];
    this.parentNode = null;
    this.style = { setProperty() {} };
    this.clientWidth = 1200;
    this.clientHeight = 800;
    this.textContent = "";
  }

  set innerHTML(value) {
    if (value === "") {
      this.children = [];
    }
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    child.parentNode = this;
    const index = this.children.indexOf(reference);
    if (index < 0) {
      this.children.push(child);
    } else {
      this.children.splice(index, 0, child);
    }
    return child;
  }

  remove() {
    if (!this.parentNode) {
      return;
    }
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") {
      this.classList.setFromString(value);
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener() {}
  removeEventListener() {}

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
}

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, new FakeElement(id === "wire-layer" ? "svg" : "div"));
    }
    return elements.get(id);
  },
  createElement(tagName) {
    return new FakeElement(tagName);
  },
  createElementNS(_namespace, tagName) {
    return new FakeElement(tagName);
  },
};

const { state, wireLayer } = await import("../js/state.js");
const { updateWireGeometry, updateWires, updateWiresForModule } = await import("../js/wire.js");

test("drag-time wire updates patch existing SVG nodes instead of rebuilding the layer", () => {
  state.selection = { type: "wire", id: "wire-a" };
  state.connecting = null;
  state.modules = [
    {
      id: "mod-a",
      type: "combo",
      name: "A",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      strokeWidth: 2,
      ports: [{ id: "port-a", name: "Out", side: "right", offset: 0.5 }],
    },
    {
      id: "mod-b",
      type: "combo",
      name: "B",
      x: 240,
      y: 0,
      width: 100,
      height: 80,
      strokeWidth: 2,
      ports: [{ id: "port-b", name: "In", side: "left", offset: 0.5 }],
    },
  ];
  state.wires = [{
    id: "wire-a",
    from: { moduleId: "mod-a", portId: "port-a" },
    to: { moduleId: "mod-b", portId: "port-b" },
    label: "",
    labelAt: "end",
    route: "H",
    bend: 170,
    bends: null,
    color: "#263238",
    width: 2.5,
    style: "solid",
  }];

  updateWires(() => {}, () => {});
  const originalChildren = [...wireLayer.children];
  const hitLayer = originalChildren.find((element) => element.classList.contains("wire-hit-layer"));
  const handleLayer = originalChildren.find((element) => element.classList.contains("wire-handle-layer"));
  const hitPath = hitLayer.children.find((element) => element.classList.contains("wire-hit"));
  const visiblePath = originalChildren.find((element) => element.classList.contains("wire-visual"));
  const originalPath = visiblePath.getAttribute("d");
  const originalHitPath = hitPath.getAttribute("d");
  assert.equal(wireLayer.children.indexOf(hitLayer) < wireLayer.children.indexOf(visiblePath), true);
  assert.equal(handleLayer.children.length > 0, true);

  state.modules[0].y = 60;
  assert.equal(updateWiresForModule("mod-a"), true);
  assert.equal(hitLayer.children.includes(hitPath), true);
  assert.equal(wireLayer.children.includes(visiblePath), true);
  assert.notEqual(visiblePath.getAttribute("d"), originalPath);
  assert.notEqual(hitPath.getAttribute("d"), originalHitPath);
  assert.equal(wireLayer.children.at(-1), handleLayer);

  state.wires[0].color = "#ff0000";
  assert.equal(updateWireGeometry("wire-a"), true);
  assert.equal(visiblePath.getAttribute("stroke"), "#ff0000");

  state.wires = [];
  assert.equal(updateWiresForModule("mod-a"), false);
  updateWires(() => {}, () => {});
  assert.equal(wireLayer.children.some((element) => element.classList.contains("wire-visual")), false);
});
