/**
 * Constants - 常量定义
 * 包含模块库、默认配置、线型样式等
 */

export const NS = "http://www.w3.org/2000/svg";

export const MODULE_LIBRARY = {
  alu: {
    label: "ALU",
    width: 170,
    height: 110,
    ports: [
      { name: "Src1", side: "left", offset: 0.25 },
      { name: "Src2", side: "left", offset: 0.7 },
      { name: "ALUOp", side: "top", offset: 0.5 },
      { name: "Out", side: "right", offset: 0.5 },
    ],
  },
  reg: {
    label: "Reg",
    width: 120,
    height: 160,
    ports: [
      { name: "addr", side: "left", offset: 0.3 },
      { name: "din", side: "left", offset: 0.7 },
      { name: "spo", side: "right", offset: 0.5 },
      { name: "CLK", side: "top", offset: 0.5, clock: true },
    ],
  },
  seq: {
    label: "Seq",
    width: 150,
    height: 90,
    ports: [
      { name: "InA", side: "left", offset: 0.35 },
      { name: "InB", side: "left", offset: 0.7 },
      { name: "Out", side: "right", offset: 0.5 },
      { name: "CLK", side: "top", offset: 0.5, clock: true },
    ],
  },
  combo: {
    label: "Comb",
    width: 150,
    height: 90,
    ports: [
      { name: "InA", side: "left", offset: 0.3 },
      { name: "InB", side: "left", offset: 0.7 },
      { name: "Out", side: "right", offset: 0.5 },
    ],
  },
  extender: {
    label: "Extender",
    width: 160,
    height: 60,
    ports: [
      { name: "In", side: "left", offset: 0.6 },
      { name: "Out", side: "right", offset: 0.5 },
    ],
  },
  mux: {
    label: "M",
    width: 60,
    height: 180,
    ports: [],
  },
};

export const DEFAULT_MODULE = {
  nameSize: 14,
  showType: false,
  fill: "",
  strokeColor: "",
  strokeWidth: 3,
};

export const MUX_DEFAULT = {
  inputs: 2,
  controlSide: "top",
  controlOffsetTop: 0.55,
  controlOffsetBottom: 0.55,
  slopeAngle: 60,
  minRight: 24,
};

export const EXTENDER_DEFAULT = {
  slopeRatio: 0.25,
  minOffset: 10,
  edgePadding: 18,
};

export const DEFAULT_WIRE = {
  color: "#263238",
  width: 2.5,
  style: "solid",
};

// Minimum distance between wires and module edges
export const WIRE_MARGIN = 20;

export const DEFAULT_CANVAS_BG = "#f6f1e8";
export const DEFAULT_PORT_LABEL_SIZE = 14;
export const PORT_LABEL_SIZE_RANGE = { min: 8, max: 32 };
export const GRID_SIZE = 24;
export const WIRE_SNAP_DISTANCE = 8;
export const WIRE_SNAP_MODES = {
  NONE: "none",
  PORT: "port",
  GRID_AND_PORT: "grid-port",
};
export const DEFAULT_WIRE_SNAP_MODE = WIRE_SNAP_MODES.GRID_AND_PORT;

export const HISTORY_MAX_STEPS = 5;

export const WIRE_STYLES = {
  solid: "",
  dashed: "8 6",
  dotted: "2 6",
};
