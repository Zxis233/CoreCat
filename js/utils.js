/**
 * Utils - 工具函数
 * 包含通用工具函数和辅助方法
 */

import { state, canvas } from './state.js';
import {
  NS,
  MUX_DEFAULT,
  EXTENDER_DEFAULT,
  DEFAULT_CANVAS_BG,
  DEFAULT_PORT_LABEL_SIZE,
  PORT_LABEL_SIZE_RANGE
} from './constants.js';

/**
 * 将值限制在指定范围内
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 节流函数 - 限制函数调用频率
 * 使用时间间隔进行节流，确保函数在指定时间内最多执行一次
 * @param {Function} fn - 要节流的函数
 * @param {number} delay - 节流延迟（毫秒）
 * @returns {Function} 节流后的函数
 */
export function throttle(fn, delay) {
  let lastCall = 0;
  let timeoutId = null;

  return function (...args) {
    const now = Date.now();
    const remaining = delay - (now - lastCall);

    if (remaining <= 0) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      lastCall = now;
      fn.apply(this, args);
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

/**
 * 生成唯一ID
 */
export function uid(prefix) {
  return `${prefix}-${state.nextId++}`;
}

/**
 * 获取画布上的点坐标（考虑缩放和偏移）
 */
export function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - state.view.offsetX) / state.view.scale,
    y: (event.clientY - rect.top - state.view.offsetY) / state.view.scale,
  };
}

/**
 * 通过ID获取模块
 */
export function getModuleById(id) {
  return state.modules.find((mod) => mod.id === id);
}

/**
 * 通过ID获取端口
 */
export function getPortById(mod, portId) {
  return mod.ports.find((port) => port.id === portId);
}

/**
 * 检查是否为时钟端口
 */
const CLOCKED_TYPES = new Set(["reg", "seq"]);
export function isClockPort(mod, port) {
  if (!mod || !port) return false;
  if (!CLOCKED_TYPES.has(mod.type)) return false;
  // return port.clock === true || port.name === "CLK";
  return port.clock === true || String(port.name).toUpperCase() === "CLK";
}

/**
 * XML转义
 */
export function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * 创建SVG元素
 */
export function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([key, value]) => {
    el.setAttribute(key, value);
  });
  return el;
}

/**
 * 检查目标是否为输入元素
 */
export function isTypingTarget(target) {
  if (!target) {
    return false;
  }
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/**
 * 获取画布背景颜色
 */
export function getCanvasBackgroundColor() {
  return state.canvasBackground || DEFAULT_CANVAS_BG;
}

/**
 * 应用画布背景
 */
export function applyCanvasBackground() {
  if (state.canvasBackground) {
    canvas.style.background = state.canvasBackground;
  } else {
    canvas.style.background = "";
  }
}

/**
 * 应用端口标签字体大小
 */
export function applyPortLabelSize() {
  const range = PORT_LABEL_SIZE_RANGE || { min: 8, max: 32 };
  const min = Number.isFinite(range.min) ? range.min : 8;
  const max = Number.isFinite(range.max) ? range.max : 32;
  const raw = Number.isFinite(state.portLabelSize) ? state.portLabelSize : DEFAULT_PORT_LABEL_SIZE;
  const size = clamp(Math.round(raw), min, max);
  state.portLabelSize = size;
  canvas.style.setProperty("--port-label-size", `${size}px`);
}

/**
 * 获取MUX的切角值
 */
export function getMuxCut(mod) {
  const angle = ((90 - MUX_DEFAULT.slopeAngle) * Math.PI) / 180;
  const cut = mod.width * Math.tan(angle);
  return clamp(cut, 8, mod.width - 12);
}

/**
 * 获取Extender顶部斜边偏移
 */
export function getExtenderOffset(mod) {
  const height = Number.isFinite(mod.height) ? mod.height : 0;
  const rawOffset = Math.round(height * EXTENDER_DEFAULT.slopeRatio);
  const maxOffset = Math.max(EXTENDER_DEFAULT.minOffset, height - EXTENDER_DEFAULT.edgePadding);
  return clamp(rawOffset, EXTENDER_DEFAULT.minOffset, maxOffset);
}

/**
 * 计算MUX最小高度
 */
export function muxMinHeight(width) {
  const angle = ((90 - MUX_DEFAULT.slopeAngle) * Math.PI) / 180;
  return Math.max(60, 2 * width * Math.tan(angle) + MUX_DEFAULT.minRight);
}

/**
 * 计算MUX最大宽度
 */
export function muxMaxWidth(height) {
  const angle = ((90 - MUX_DEFAULT.slopeAngle) * Math.PI) / 180;
  const maxCut = Math.max(0, (height - MUX_DEFAULT.minRight) / 2);
  if (maxCut <= 0) {
    return 0;
  }
  return maxCut / Math.tan(angle);
}

/**
 * 确保MUX几何形状正确
 */
export function ensureMuxGeometry(mod, mode) {
  mod.width = clamp(Math.round(mod.width), 60, 300);
  mod.height = clamp(Math.round(mod.height), 120, 600);

  if (mode === "keepHeight") {
    const maxWidth = muxMaxWidth(mod.height);
    if (Number.isFinite(maxWidth) && maxWidth > 0 && mod.width > maxWidth) {
      mod.width = Math.max(60, Math.round(maxWidth));
    }
  }

  const minHeight = muxMinHeight(mod.width);
  if (mod.height < minHeight) {
    mod.height = Math.round(minHeight);
  }
  return getMuxCut(mod);
}

/**
 * 解析RGB/RGBA颜色字符串
 * 支持 rgb(r, g, b)、rgba(r, g, b, a) 和十六进制格式（#RGB、#RRGGBB、#RRGGBBAA）
 * @param {string} color - 颜色字符串
 * @param {boolean} includeAlpha - 是否返回alpha值，默认false
 * @returns {Object|null} 返回 {r, g, b} 或 {r, g, b, a}，解析失败返回null
 */
export function parseRgb(color, includeAlpha = false) {
  if (typeof color !== "string") {
    return null;
  }
  const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (rgbaMatch) {
    const r = Number.parseInt(rgbaMatch[1], 10);
    const g = Number.parseInt(rgbaMatch[2], 10);
    const b = Number.parseInt(rgbaMatch[3], 10);
    const a = rgbaMatch[4] !== undefined ? Number.parseFloat(rgbaMatch[4]) : 1;
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) {
      return null;
    }
    return includeAlpha ? { r, g, b, a } : { r, g, b };
  }
  if (color.startsWith("#")) {
    let hex = color.slice(1).trim();
    if (hex.length === 3) {
      hex = hex.split("").map((ch) => ch + ch).join("");
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) {
        return null;
      }
      return includeAlpha ? { r, g, b, a } : { r, g, b };
    }
  }
  return null;
}

/**
 * 获取模块渐变填充的SVG定义和填充属性
 * 与CSS中 color-mix 渐变一致，根据模块类型的 stroke 颜色生成渐变
 */
export function getModuleGradientFill(mod, strokeColor, gradientId = "moduleGradient") {
  const hasFill = typeof mod.fill === "string" && mod.fill !== "";
  const useGradient = !hasFill;
  const fillAttr = useGradient ? `url(#${gradientId})` : mod.fill;

  // 根据 stroke 颜色生成渐变，模拟 CSS color-mix(in srgb, strokeColor 16%, white) 和 color-mix(in srgb, strokeColor 8%, white)
  // 使用 stroke 颜色的淡色版本作为渐变
  let gradientDef = "";
  if (useGradient) {
    const rgb = parseRgb(strokeColor);
    if (rgb) {
      // 16% stroke color mixed with white
      const r1 = Math.round(rgb.r * 0.16 + 255 * 0.84);
      const g1 = Math.round(rgb.g * 0.16 + 255 * 0.84);
      const b1 = Math.round(rgb.b * 0.16 + 255 * 0.84);
      // 8% stroke color mixed with white
      const r2 = Math.round(rgb.r * 0.08 + 255 * 0.92);
      const g2 = Math.round(rgb.g * 0.08 + 255 * 0.92);
      const b2 = Math.round(rgb.b * 0.08 + 255 * 0.92);
      gradientDef = `<defs><linearGradient id="${gradientId}" x1="0%" y1="0%" x2="70%" y2="100%"><stop offset="0%" stop-color="rgba(${r1}, ${g1}, ${b1}, 0.95)"/><stop offset="100%" stop-color="rgba(${r2}, ${g2}, ${b2}, 0.92)"/></linearGradient></defs>`;
    } else {
      // 如果无法解析颜色，使用默认渐变
      gradientDef = `<defs><linearGradient id="${gradientId}" x1="0%" y1="0%" x2="70%" y2="100%"><stop offset="0%" stop-color="rgba(255, 255, 255, 0.95)"/><stop offset="100%" stop-color="rgba(245, 239, 229, 0.92)"/></linearGradient></defs>`;
    }
  }
  return { fillAttr, gradientDef };
}

/**
 * 构建MUX SVG背景
 */
export function buildMuxSvgBackground(mod) {
  const width = mod.width;
  const height = mod.height;
  const cut = getMuxCut(mod);
  // 默认颜色与 module.css 中 .module.mux 的 --module-stroke 一致
  const strokeColor = mod.strokeColor || 'rgba(150, 108, 203, 0.6)';
  const strokeWidth = Number.isFinite(mod.strokeWidth) ? mod.strokeWidth : 2;

  // 梯形路径：左上 -> 右上(下移cut) -> 右下(上移cut) -> 左下
  const sw2 = strokeWidth / 2;
  const path = `M ${sw2} ${sw2} L ${width - sw2} ${cut} L ${width - sw2} ${height - cut} L ${sw2} ${height - sw2} Z`;

  const { fillAttr, gradientDef } = getModuleGradientFill(mod, strokeColor);

  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>${gradientDef}<path d='${path}' fill='${fillAttr}' stroke='${strokeColor}' stroke-width='${strokeWidth}' stroke-linejoin='round'/></svg>`;

  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * 构建Extender SVG背景
 */
export function buildExtenderSvgBackground(mod) {
  const width = mod.width;
  const height = mod.height;
  const offset = getExtenderOffset(mod);
  // 默认颜色与 module.css 中 .module.extender 的 --module-stroke 一致
  const strokeColor = mod.strokeColor || 'rgba(200, 110, 140, 0.8)';
  const strokeWidth = Number.isFinite(mod.strokeWidth) ? mod.strokeWidth : 2;
  const sw2 = strokeWidth / 2;
  const topLeftY = Math.max(sw2, offset);
  const path = `M ${sw2} ${topLeftY} L ${width - sw2} ${sw2} L ${width - sw2} ${height - sw2} L ${sw2} ${height - sw2} Z`;

  const { fillAttr, gradientDef } = getModuleGradientFill(mod, strokeColor);

  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>${gradientDef}<path d='${path}' fill='${fillAttr}' stroke='${strokeColor}' stroke-width='${strokeWidth}' stroke-linejoin='round'/></svg>`;

  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
