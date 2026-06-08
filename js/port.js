/**
 * Port - 端口相关功能
 * 包含端口位置计算、描述等
 */

import { state } from './state.js';
import { clamp, getModuleById, getPortById, getMuxCut } from './utils.js';

/**
 * 获取端口本地位置（相对于模块）
 */
export function getPortLocalPosition(mod, port) {
  // 获取边框宽度，默认为 1px
  const borderWidth = Number.isFinite(mod.strokeWidth) ? mod.strokeWidth : 1;

  if (port.side === "slopeTop" || port.side === "slopeBottom") {
    const cut = getMuxCut(mod);
    const t = clamp(port.offset, 0, 1);
    const sw2 = borderWidth / 2;
    // x is the same for both slopeTop and slopeBottom
    const x = sw2 + t * (mod.width - 2 * sw2);
    // slopeTop: from (sw2, sw2) to (width - sw2, cut)
    // slopeBottom: from (sw2, height - sw2) to (width - sw2, height - cut)
    const y = port.side === "slopeTop"
      ? sw2 + t * (cut - sw2)
      : (mod.height - sw2) - t * (cut - sw2);
    return { x, y };
  }
  if (port.side === "left") {
    return { x: borderWidth / 2, y: mod.height * port.offset };
  }
  if (port.side === "right") {
    return { x: mod.width - borderWidth / 2, y: mod.height * port.offset };
  }
  if (port.side === "top") {
    return { x: mod.width * port.offset, y: borderWidth / 2 };
  }
  // bottom
  return { x: mod.width * port.offset, y: mod.height - borderWidth / 2 };
}

/**
 * 获取端口全局位置
 */
export function getPortPosition(mod, port) {
  const local = getPortLocalPosition(mod, port);
  return {
    x: mod.x + local.x,
    y: mod.y + local.y,
  };
}

export function getPortByRef(ref) {
  if (!ref || typeof ref !== "object") {
    return null;
  }
  const mod = getModuleById(ref.moduleId);
  if (!mod) {
    return null;
  }
  const port = getPortById(mod, ref.portId);
  if (!port) {
    return null;
  }
  return { mod, port };
}

/**
 * 通过引用获取端口位置
 */
export function getPortPositionByRef(ref) {
  const portRef = getPortByRef(ref);
  if (!portRef) {
    return null;
  }
  return getPortPosition(portRef.mod, portRef.port);
}

/**
 * 描述端口引用
 */
export function describePortRef(ref) {
  if (!ref || typeof ref !== "object") {
    return "Unknown";
  }
  const mod = getModuleById(ref.moduleId);
  if (!mod) {
    return "Unknown";
  }
  const port = getPortById(mod, ref.portId);
  if (!port) {
    return mod.name;
  }
  return `${mod.name}:${port.name}`;
}
