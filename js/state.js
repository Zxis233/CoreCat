/**
 * State - 应用状态管理
 * 包含全局状态对象和DOM元素引用
 */

import { DEFAULT_PORT_LABEL_SIZE } from './constants.js';

export const state = {
  modules: [],
  wires: [],
  selection: null,
  connecting: null,
  drag: null,
  dragWire: null,
  pan: null,
  nextId: 1,
  typeCounts: {},
  canvasBackground: "",
  portLabelSize: DEFAULT_PORT_LABEL_SIZE,
  view: {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  },
  export: {
    transparent: true,
    fitToBounds: true,
  },
};

// 模块DOM元素映射
export const moduleElements = new Map();

// DOM元素引用
export const canvas = document.getElementById("canvas");
export const wireLayer = document.getElementById("wire-layer");
export const moduleLayer = document.getElementById("module-layer");
export const propertiesContent = document.getElementById("properties-content");
export const statusEl = document.getElementById("status");
