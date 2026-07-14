/**
 * Export - 导出功能
 * 包含SVG和PNG导出
 */

import { state, canvas } from './state.js';
import {
  MODULE_LIBRARY,
  DEFAULT_MODULE,
  DEFAULT_WIRE,
  WIRE_STYLES,
  DEFAULT_CANVAS_BG,
  DEFAULT_PORT_LABEL_SIZE,
  PORT_LABEL_SIZE_RANGE
} from './constants.js';
import {
  escapeXml,
  getMuxCut,
  getExtenderOffset,
  getCanvasBackgroundColor,
  applyCanvasBackground,
  applyPortLabelSize,
  ensureMuxGeometry,
  getModuleGradientFill,
  parseRgb,
  sanitizeSvgPaint
} from './utils.js';
import { getPortLocalPosition, getPortPositionByRef } from './port.js';
import {
  buildWirePath,
  wireLabelPosition,
  pointKey,
  collectWireRenderItems,
  computeWireOverlapKeys,
  BEND_MARKER_MIN_RADIUS,
  BEND_MARKER_OVERLAP_BOOST
} from './wire.js';
import { ensureMuxPorts, isKnownModuleType } from './module.js';
import {
  DIAGRAM_SCHEMA_VERSION,
  countModuleTypes,
  normalizeDiagram,
  normalizeModuleImports
} from './diagram-normalize.js';

export { DIAGRAM_SCHEMA_VERSION, normalizeDiagram, normalizeModuleImports } from './diagram-normalize.js';

const MODULE_STROKE_COLORS = {
  alu: "rgba(242, 193, 78, 0.8)",
  reg: "rgba(59, 125, 115, 0.8)",
  seq: "rgba(224, 122, 95, 0.8)",
  combo: "rgba(58, 114, 176, 0.8)",
  extender: "rgba(200, 110, 140, 0.8)",
  mux: "rgba(150, 108, 203, 0.6)",
};
const DEFAULT_STROKE_COLOR = "rgba(31, 38, 43, 0.18)";
const STORAGE_KEY = "corecat-diagram";
const AUTO_SAVE_DELAY = 250;
let autoSaveTimer = null;
let hasUnsavedChanges = false;
let documentRevision = 0;
const PORT_COLOR_MIX_RATIO = 0.5;
const PNG_MIN_SCALE = 2;
const PNG_MAX_SCALE = 4;
const PNG_MAX_DIMENSION = 16384;
const PNG_MAX_PIXELS = 64 * 1024 * 1024;

function emitStorageStatus(detail, defer = false) {
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent !== "function"
  ) {
    return;
  }
  const dispatch = () => {
    window.dispatchEvent(new CustomEvent("corecat:storage-status", { detail }));
  };
  if (defer && typeof window.setTimeout === "function") {
    window.setTimeout(dispatch, 0);
  } else {
    dispatch();
  }
}

function reportPngExportFailure(message, error) {
  if (error) {
    console.error("CoreCat PNG export failed:", error);
  }
  if (typeof alert === "function") {
    alert(message);
  }
}

function resolvePngOutputSize(width, height, scale) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, message: "PNG export has invalid dimensions." };
  }

  const pixelWidth = Math.ceil(width * scale);
  const pixelHeight = Math.ceil(height * scale);
  const pixelCount = pixelWidth * pixelHeight;
  if (
    !Number.isSafeInteger(pixelWidth) ||
    !Number.isSafeInteger(pixelHeight) ||
    pixelWidth <= 0 ||
    pixelHeight <= 0 ||
    pixelWidth > PNG_MAX_DIMENSION ||
    pixelHeight > PNG_MAX_DIMENSION ||
    !Number.isSafeInteger(pixelCount) ||
    pixelCount > PNG_MAX_PIXELS
  ) {
    return {
      ok: false,
      message: `PNG export is too large (${pixelWidth} x ${pixelHeight} px). Reduce the diagram size or export SVG instead.`,
    };
  }

  return { ok: true, pixelWidth, pixelHeight };
}

function resolvePortLabelSize() {
  const range = PORT_LABEL_SIZE_RANGE || { min: 8, max: 32 };
  const min = Number.isFinite(range.min) ? range.min : 8;
  const max = Number.isFinite(range.max) ? range.max : 32;
  const raw = Number.isFinite(state.portLabelSize) ? state.portLabelSize : DEFAULT_PORT_LABEL_SIZE;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

function reportNormalizeIssues(result, silent) {
  if (result.errors.length > 0 || result.warnings.length > 0) {
    console.warn("CoreCat diagram import issues:", {
      errors: result.errors,
      warnings: result.warnings,
    });
  }
  if (!silent && result.errors.length > 0) {
    alert(result.errors[0]);
  }
  if (
    !silent &&
    result.errors.length === 0 &&
    result.warnings.length > 0 &&
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent === "function"
  ) {
    const dispatchWarning = () => {
      window.dispatchEvent(new CustomEvent("corecat:import-warning", {
        detail: { warnings: [...result.warnings] },
      }));
    };
    if (typeof window.setTimeout === "function") {
      window.setTimeout(dispatchWarning, 0);
    } else {
      dispatchWarning();
    }
  }
}

/**
 * 保存至本地存储
 */
export function saveDiagramToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState()));
    hasUnsavedChanges = false;
    return { ok: true };
  } catch (err) {
    hasUnsavedChanges = true;
    const error = err instanceof Error ? err : new Error(String(err));
    console.error("CoreCat diagram save failed:", error);
    return { ok: false, error };
  }
}

/**
 * 计划自动保存
 */
export function scheduleAutoSave(delay = AUTO_SAVE_DELAY) {
  documentRevision += 1;
  hasUnsavedChanges = true;
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
  }
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    const result = saveDiagramToStorage();
    emitStorageStatus({ source: "autosave", ...result });
  }, delay);
}

export function getDocumentRevision() {
  return documentRevision;
}

/**
 * Persist any pending autosave immediately, for example during pagehide.
 */
export function flushAutoSave() {
  if (!autoSaveTimer && !hasUnsavedChanges) {
    return { ok: true, skipped: true };
  }
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  return saveDiagramToStorage();
}

/**
 * 从本地存储加载
 */
export function loadDiagramFromStorage(callbacks) {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    emitStorageStatus({ source: "restore", ok: false, error }, true);
    return false;
  }
  if (!raw) {
    return false;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    emitStorageStatus({ source: "restore", ok: false, error }, true);
    return false;
  }
  const loaded = loadState(data, callbacks, { silent: true });
  if (!loaded) {
    emitStorageStatus({
      source: "restore",
      ok: false,
      error: new Error("Stored diagram data is invalid or exceeds current limits."),
    }, true);
  }
  return loaded;
}

/**
 * 清理本地存储
 */
export function clearDiagramStorage() {
  documentRevision += 1;
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  hasUnsavedChanges = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
    return { ok: true };
  } catch (err) {
    hasUnsavedChanges = true;
    const error = err instanceof Error ? err : new Error(String(err));
    console.error("CoreCat diagram clear failed:", error);
    return { ok: false, error };
  }
}

function resolveModuleStrokeColor(mod) {
  if (typeof mod.strokeColor === "string" && mod.strokeColor.trim() !== "") {
    return mod.strokeColor;
  }
  return MODULE_STROKE_COLORS[mod.type] || DEFAULT_STROKE_COLOR;
}

function makeGradientId(mod, index) {
  const raw = typeof mod.id === "string" && mod.id ? mod.id : `module-${index}`;
  return `moduleGradient-${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function mixWithBlack(color, ratio = PORT_COLOR_MIX_RATIO) {
  const rgb = parseRgb(color, true); // Use shared parseRgb function with alpha value included
  if (!rgb) {
    return "";
  }
  const r = Math.round(rgb.r * ratio);
  const g = Math.round(rgb.g * ratio);
  const b = Math.round(rgb.b * ratio);
  const a = rgb.a * ratio + (1 - ratio);
  if (a >= 0.999) {
    return `rgb(${r}, ${g}, ${b})`;
  }
  const alpha = Math.round(a * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function resolvePortFillColor(strokeColor) {
  const mixed = mixWithBlack(strokeColor);
  if (mixed) {
    return mixed;
  }
  const fallback = mixWithBlack(DEFAULT_STROKE_COLOR);
  return fallback || "#1d262b";
}

function getPortLabelPlacement(mod, portSide, labelHalfHeight) {
  const isOffsetPort = mod.type === "extender" || mod.type === "mux";
  const leftOffset = isOffsetPort ? 7 : 6;
  const rightOffset = isOffsetPort ? -8 : -10;
  switch (portSide) {
    case "left":
      return { dx: leftOffset, dy: -2, anchor: "start" };
    case "right":
      return { dx: rightOffset, dy: -2, anchor: "end" };
    case "top":
      return { dx: -2, dy: 3 + labelHalfHeight, anchor: "middle" };
    case "bottom":
      return { dx: -2, dy: -(10 + labelHalfHeight), anchor: "middle" };
    case "slopeTop":
      return { dx: -1, dy: 6 + labelHalfHeight, anchor: "middle" };
    case "slopeBottom":
      return { dx: 1, dy: -(6 + labelHalfHeight), anchor: "middle" };
    default:
      return { dx: 0, dy: 0, anchor: "middle" };
  }
}

function buildClockMarkerPath(x, y, width, height, pointDown) {
  if (pointDown) {
    return `M ${x + 1} ${y + 1} L ${x + width - 1} ${y + 1} L ${x + width / 2} ${y + height - 1} Z`;
  }
  return `M ${x + width / 2} ${y + 1} L ${x + width - 1} ${y + height - 1} L ${x + 1} ${y + height - 1} Z`;
}

/**
 * 计算图表边界
 */
export function computeDiagramBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const extendPoint = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  const extendRect = (x, y, width, height) => {
    extendPoint(x, y);
    extendPoint(x + width, y + height);
  };

  state.modules.forEach((mod) => {
    extendRect(mod.x, mod.y, mod.width, mod.height);
  });

  state.wires.forEach((wire) => {
    const start = getPortPositionByRef(wire.from);
    const end = getPortPositionByRef(wire.to);
    if (!start || !end) {
      return;
    }
    extendPoint(start.x, start.y);
    extendPoint(end.x, end.y);

    if (Array.isArray(wire.bends) && wire.bends.length > 0) {
      wire.bends.forEach((bend) => {
        extendPoint(bend.x, bend.y);
      });
    } else if (wire.route === "V") {
      extendPoint(start.x, wire.bend);
      extendPoint(end.x, wire.bend);
    } else {
      extendPoint(wire.bend, start.y);
      extendPoint(wire.bend, end.y);
    }
    if (wire.label) {
      const labelPos = wireLabelPosition(wire, start, end);
      const pad = 24;
      extendRect(labelPos.x - pad, labelPos.y - pad, pad * 2, pad * 2);
    }
  });

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null;
  }

  return { minX, minY, maxX, maxY };
}

/**
 * 构建导出SVG
 */
export function buildExportSvg(options) {
  const background = options && options.transparent ? "" : sanitizeSvgPaint(getCanvasBackgroundColor(), DEFAULT_CANVAS_BG);
  const useBounds = options && options.fitToBounds;
  const padding = 32;
  const bounds = useBounds ? computeDiagramBounds() : null;
  const width = bounds ? Math.ceil(bounds.maxX - bounds.minX + padding * 2) : canvas.clientWidth;
  const height = bounds ? Math.ceil(bounds.maxY - bounds.minY + padding * 2) : canvas.clientHeight;
  const offsetX = bounds ? -bounds.minX + padding : state.view.offsetX;
  const offsetY = bounds ? -bounds.minY + padding : state.view.offsetY;
  const scale = bounds ? 1 : state.view.scale;
  const portLabelFontSize = resolvePortLabelSize();
  const portLabelHalfHeight = portLabelFontSize / 2;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(
    "<style>",
    ".wire{fill:none;stroke-linecap:round;stroke-linejoin:round;}",
    ".wire-bend{pointer-events:none;opacity:0;}",
    ".wire-bend.overlap{stroke-width:2;opacity:1;}",
    ".module-name{font-family:MiSans VF,Noto Sans SC,Trebuchet MS,Lucida Sans Unicode,Lucida Grande,sans-serif;font-weight:700;fill:#1d262b;}",
    ".module-type{font-family:MiSans VF,Noto Sans SC,Trebuchet MS,Lucida Sans Unicode,Lucida Grande,sans-serif;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;fill:#6b6f6f;}",
    `.port-label{font-family:Maple Mono Normal NF CN,Maple Mono NF CN,Consolas,Courier New,monospace;font-size:${portLabelFontSize}px;fill:#1d262b;}`,
    ".wire-label{font-family:Maple Mono Normal NF CN,Maple Mono NF CN,Consolas,Courier New,monospace;font-size:11px;}",
    "</style>"
  );
  if (background) {
    parts.push(`<rect width="100%" height="100%" fill="${escapeXml(background)}"></rect>`);
  }
  parts.push(`<g transform="translate(${offsetX} ${offsetY}) scale(${scale})">`);

  const { renderItems: wireRenderItems, bendPointMap, renderItemMap } = collectWireRenderItems();
  const overlapKeys = computeWireOverlapKeys(wireRenderItems, bendPointMap, renderItemMap);

  wireRenderItems.forEach(({ wire, start, end, bendPoints }) => {
    const color = sanitizeSvgPaint(wire.color, DEFAULT_WIRE.color);
    const colorAttr = escapeXml(color);
    const widthValue = Number.isFinite(wire.width) ? wire.width : DEFAULT_WIRE.width;
    const dash = WIRE_STYLES[wire.style] || "";
    const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
    parts.push(`<path class="wire" d="${buildWirePath(wire, start, end)}" stroke="${colorAttr}" stroke-width="${widthValue}"${dashAttr}></path>`);
    if (bendPoints.length > 0) {
      const baseRadius = Math.max(BEND_MARKER_MIN_RADIUS, widthValue * 0.7);
      bendPoints.forEach((point) => {
        const key = pointKey(point);
        const isOverlap = overlapKeys.has(key);
        const radius = isOverlap ? baseRadius + BEND_MARKER_OVERLAP_BOOST : baseRadius;
        parts.push(`<circle class="wire-bend${isOverlap ? " overlap" : ""}" cx="${point.x}" cy="${point.y}" r="${radius}" fill="${colorAttr}"></circle>`);
      });
    }
    if (wire.label) {
      const labelPos = wireLabelPosition(wire, start, end);
      const labelAnchor = labelPos.anchor || "middle";
      const labelBaseline = labelPos.baseline || "central";
      const labelTransform = labelPos.angle ? ` transform="rotate(${labelPos.angle} ${labelPos.x} ${labelPos.y})"` : "";
      parts.push(
        `<text class="wire-label" x="${labelPos.x}" y="${labelPos.y}" text-anchor="${labelAnchor}" dominant-baseline="${labelBaseline}" fill="${colorAttr}"${labelTransform}>${escapeXml(
          wire.label
        )}</text>`
      );
    }
  });

  state.modules.forEach((mod, index) => {
    const stroke = sanitizeSvgPaint(resolveModuleStrokeColor(mod), DEFAULT_STROKE_COLOR);
    const strokeAttr = escapeXml(stroke);
    const strokeWidth = Number.isFinite(mod.strokeWidth) ? mod.strokeWidth : DEFAULT_MODULE.strokeWidth;
    const gradientId = makeGradientId(mod, index);
    const exportMod = { ...mod, fill: sanitizeSvgPaint(mod.fill, "") };
    const { fillAttr, gradientDef } = getModuleGradientFill(exportMod, stroke, gradientId);
    const safeFillAttr = escapeXml(fillAttr);
    const sw2 = strokeWidth / 2;
    parts.push(`<g transform="translate(${mod.x} ${mod.y})">`);
    if (gradientDef) {
      parts.push(gradientDef);
    }
    if (mod.type === "mux") {
      const cut = getMuxCut(mod);
      const path = `M ${sw2} ${sw2} L ${mod.width - sw2} ${cut} L ${mod.width - sw2} ${mod.height - cut} L ${sw2} ${mod.height - sw2} Z`;
      parts.push(`<path d="${path}" fill="${safeFillAttr}" stroke="${strokeAttr}" stroke-width="${strokeWidth}" stroke-linejoin="round"></path>`);
    } else if (mod.type === "extender") {
      const offset = getExtenderOffset(mod);
      const topLeftY = Math.max(sw2, offset);
      const path = `M ${sw2} ${topLeftY} L ${mod.width - sw2} ${sw2} L ${mod.width - sw2} ${mod.height - sw2} L ${sw2} ${mod.height - sw2} Z`;
      parts.push(`<path d="${path}" fill="${safeFillAttr}" stroke="${strokeAttr}" stroke-width="${strokeWidth}" stroke-linejoin="round"></path>`);
    } else {
      const rectWidth = Math.max(0, mod.width - strokeWidth);
      const rectHeight = Math.max(0, mod.height - strokeWidth);
      const radius = Math.max(0, 14 - sw2);
      parts.push(
        `<rect x="${sw2}" y="${sw2}" width="${rectWidth}" height="${rectHeight}" rx="${radius}" ry="${radius}" fill="${safeFillAttr}" stroke="${strokeAttr}" stroke-width="${strokeWidth}"></rect>`
      );
    }

    const nameSize = Number.isFinite(mod.nameSize) ? mod.nameSize : DEFAULT_MODULE.nameSize;
    const centerX = mod.width / 2;
    const centerY = mod.height / 2;
    const titleOffset = mod.type === "extender" ? nameSize * 0.5 : 0;
    if (mod.showType) {
      const typeSize = 11;
      const gap = 2;
      const totalHeight = nameSize + typeSize + gap;
      const top = centerY - totalHeight / 2;
      const nameY = top + nameSize / 2 + titleOffset;
      const typeY = top + nameSize + gap + typeSize / 2;
      parts.push(
        `<text class="module-name" x="${centerX}" y="${nameY}" text-anchor="middle" dominant-baseline="middle" font-size="${nameSize}">${escapeXml(
          mod.name
        )}</text>`
      );
      const typeLabel = isKnownModuleType(mod.type) ? MODULE_LIBRARY[mod.type].label : mod.type;
      parts.push(
        `<text class="module-type" x="${centerX}" y="${typeY}" text-anchor="middle" dominant-baseline="middle" font-size="${typeSize}">${escapeXml(
          typeLabel
        )}</text>`
      );
    } else {
      parts.push(
        `<text class="module-name" x="${centerX}" y="${centerY + titleOffset}" text-anchor="middle" dominant-baseline="middle" font-size="${nameSize}">${escapeXml(
          mod.name
        )}</text>`
      );
    }

    const CLOCKED_TYPES = new Set(["reg", "seq"]);
    const isClockPort = (port) =>
      CLOCKED_TYPES.has(mod.type) &&
      // (port.clock === true || port.name === "CLK");
      (port.clock === true || String(port.name).toUpperCase() === "CLK");

    const portFill = sanitizeSvgPaint(resolvePortFillColor(stroke), "#1d262b");
    const portFillAttr = escapeXml(portFill);
    const portOffset = mod.type === "extender" || mod.type === "mux" ? 0 : 0;

    mod.ports.forEach((port) => {
      const local = getPortLocalPosition(mod, port);
      if (isClockPort(port)) {
        const markerWidth = 24;
        const markerHeight = 12;
        const markerX = local.x - markerWidth / 2;
        const markerY = port.side === "bottom" ? local.y - markerHeight + 1 : local.y - 1;
        const markerPath = buildClockMarkerPath(markerX, markerY, markerWidth, markerHeight, port.side !== "bottom");
        parts.push(
          `<path d="${markerPath}" fill="none" stroke="${portFillAttr}" stroke-width="3" stroke-linejoin="round"></path>`
        );
        return;
      }
      parts.push(`<circle cx="${local.x + portOffset}" cy="${local.y + portOffset}" r="6" fill="${portFillAttr}"></circle>`);
      const placement = getPortLabelPlacement(mod, port.side, portLabelHalfHeight);
      const labelX = local.x + placement.dx + 2.5;
      const labelY = local.y + placement.dy + 2.5;
      const anchor = placement.anchor;
      parts.push(
        `<text class="port-label" x="${labelX}" y="${labelY}" text-anchor="${anchor}" dominant-baseline="middle">${escapeXml(port.name)}</text>`
      );
    });

    parts.push("</g>");
  });

  parts.push("</g></svg>");
  return { svg: parts.join(""), width, height };
}

/**
 * 下载Blob文件
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 导出SVG
 */
export function exportSvg() {
  const result = buildExportSvg({
    transparent: state.export.transparent,
    fitToBounds: state.export.fitToBounds,
  });
  const blob = new Blob([result.svg], { type: "image/svg+xml;charset=utf-8" });
  downloadBlob(blob, "corecat-diagram.svg");
}

/**
 * 导出PNG
 */
export function exportPng() {
  let result;
  try {
    result = buildExportSvg({
      transparent: state.export.transparent,
      fitToBounds: state.export.fitToBounds,
    });
  } catch (error) {
    reportPngExportFailure("Failed to prepare PNG export.", error);
    return false;
  }

  const deviceScale = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
  const scale = Math.min(PNG_MAX_SCALE, Math.max(PNG_MIN_SCALE, deviceScale));
  const outputSize = resolvePngOutputSize(result.width, result.height, scale);
  if (!outputSize.ok) {
    reportPngExportFailure(outputSize.message);
    return false;
  }

  let url;
  let img;
  try {
    const svgBlob = new Blob([result.svg], { type: "image/svg+xml;charset=utf-8" });
    url = URL.createObjectURL(svgBlob);
    img = new Image();
  } catch (error) {
    if (url) {
      URL.revokeObjectURL(url);
    }
    reportPngExportFailure("Failed to initialize PNG export.", error);
    return false;
  }

  let urlRevoked = false;
  const revokeUrl = () => {
    if (!urlRevoked) {
      urlRevoked = true;
      URL.revokeObjectURL(url);
    }
  };

  img.onload = () => {
    try {
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = outputSize.pixelWidth;
      exportCanvas.height = outputSize.pixelHeight;
      const ctx = exportCanvas.getContext("2d");
      if (!ctx) {
        revokeUrl();
        reportPngExportFailure("PNG export is not supported by this browser.");
        return;
      }
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, result.width, result.height);
      ctx.drawImage(img, 0, 0);
      if (typeof exportCanvas.toBlob !== "function") {
        revokeUrl();
        reportPngExportFailure("PNG export is not supported by this browser.");
        return;
      }
      exportCanvas.toBlob((blob) => {
        try {
          if (!blob) {
            reportPngExportFailure("Failed to encode PNG image.");
            return;
          }
          downloadBlob(blob, "corecat-diagram.png");
        } catch (error) {
          reportPngExportFailure("Failed to download PNG image.", error);
        } finally {
          revokeUrl();
        }
      }, "image/png");
    } catch (error) {
      revokeUrl();
      reportPngExportFailure("Failed to render PNG image.", error);
    }
  };
  img.onerror = () => {
    revokeUrl();
    reportPngExportFailure("Failed to export PNG.");
  };
  try {
    img.src = url;
  } catch (error) {
    revokeUrl();
    reportPngExportFailure("Failed to load PNG export image.", error);
    return false;
  }
  return true;
}

/**
 * 序列化状态
 */
export function serializeState() {
  return {
    schemaVersion: DIAGRAM_SCHEMA_VERSION,
    canvasBackground: state.canvasBackground,
    portLabelSize: state.portLabelSize,
    wireSnapMode: state.wireSnapMode,
    modules: state.modules.map((mod) => ({
      id: mod.id,
      type: mod.type,
      name: mod.name,
      x: mod.x,
      y: mod.y,
      width: mod.width,
      height: mod.height,
      nameSize: mod.nameSize,
      showType: mod.showType,
      fill: mod.fill,
      strokeColor: mod.strokeColor,
      strokeWidth: mod.strokeWidth,
      muxInputs: mod.muxInputs,
      muxControlSide: mod.muxControlSide,
      ports: mod.ports.map((port) => ({
        id: port.id,
        name: port.name,
        side: port.side,
        offset: port.offset,
        clock: port.clock === true,
      })),
    })),
    wires: state.wires.map((wire) => ({
      id: wire.id,
      from: wire.from && typeof wire.from === "object"
        ? { moduleId: wire.from.moduleId, portId: wire.from.portId }
        : wire.from,
      to: wire.to && typeof wire.to === "object"
        ? { moduleId: wire.to.moduleId, portId: wire.to.portId }
        : wire.to,
      label: wire.label,
      labelAt: wire.labelAt,
      route: wire.route,
      bend: wire.bend,
      bends: Array.isArray(wire.bends)
        ? wire.bends.map((bend) => ({ x: bend.x, y: bend.y }))
        : wire.bends,
      color: wire.color,
      width: wire.width,
      style: wire.style,
    })),
  };
}

/**
 * 刷新ID计数器
 */
export function refreshIdCounter() {
  let maxId = 0;
  const usedSuffixes = new Set();
  const track = (id) => {
    if (typeof id !== "string") {
      return;
    }
    const match = /-(\d+)$/.exec(id);
    if (!match) {
      return;
    }
    const suffix = Number(match[1]);
    if (Number.isSafeInteger(suffix) && suffix >= 0) {
      usedSuffixes.add(suffix);
      maxId = Math.max(maxId, suffix);
    }
  };
  state.modules.forEach((mod) => {
    track(mod.id);
    mod.ports.forEach((port) => track(port.id));
  });
  state.wires.forEach((wire) => track(wire.id));
  let nextId = maxId < Number.MAX_SAFE_INTEGER ? maxId + 1 : 1;
  while (usedSuffixes.has(nextId)) {
    nextId += 1;
  }
  state.nextId = nextId;
}

/**
 * 加载状态
 */
export function loadState(data, callbacks, options = {}) {
  const normalized = normalizeDiagram(data);
  reportNormalizeIssues(normalized, options.silent === true);
  if (!normalized.ok) {
    return false;
  }

  const diagram = normalized.diagram;
  state.canvasBackground = diagram.canvasBackground;
  applyCanvasBackground();
  state.portLabelSize = diagram.portLabelSize;
  applyPortLabelSize();
  state.wireSnapMode = diagram.wireSnapMode;
  state.modules = diagram.modules;
  state.wires = diagram.wires;
  state.typeCounts = countModuleTypes(state.modules);
  state.selection = null;
  state.connecting = null;
  state.drag = null;
  state.dragWire = null;
  state.pan = null;
  refreshIdCounter();
  state.modules.forEach((mod) => {
    if (mod.type === "mux") {
      const hasPorts = Array.isArray(mod.ports) && mod.ports.length > 0;
      if (!hasPorts) {
        ensureMuxPorts(mod);
      }
      ensureMuxGeometry(mod);
    }
  });

  if (callbacks) {
    callbacks.renderModules();
    callbacks.updateWires();
    callbacks.renderProperties();
    callbacks.updateStatus();
  }
  return true;
}
