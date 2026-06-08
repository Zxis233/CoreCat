/**
 * Module transfer helpers - pure clipboard and paste data shaping.
 */

export function buildModuleClipboardData(mod) {
  return {
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
    ports: Array.isArray(mod.ports)
      ? mod.ports.map((port) => ({
        name: port.name,
        side: port.side,
        offset: port.offset,
        clock: port.clock === true,
      }))
      : [],
  };
}

export function createModuleFromClipboardData(data, options) {
  const createId = options.createId;
  const offset = Number.isFinite(options.offset) ? options.offset : 0;
  const resolveType = options.resolveType || ((type) => type);

  return {
    id: createId("mod"),
    type: resolveType(data.type),
    name: data.name,
    x: Math.round((data.x || 0) + offset),
    y: Math.round((data.y || 0) + offset),
    width: data.width,
    height: data.height,
    nameSize: data.nameSize,
    showType: data.showType,
    fill: data.fill,
    strokeColor: data.strokeColor,
    strokeWidth: data.strokeWidth,
    muxInputs: data.muxInputs,
    muxControlSide: data.muxControlSide,
    ports: Array.isArray(data.ports)
      ? data.ports.map((port) => ({
        id: createId("port"),
        name: port.name,
        side: port.side,
        offset: port.offset,
        clock: port.clock === true,
      }))
      : [],
  };
}
