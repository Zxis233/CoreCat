/**
 * Properties - 属性面板渲染
 * 包含属性面板的渲染和交互
 */

import { state, propertiesContent } from './state.js';
import {
  MODULE_LIBRARY,
  DEFAULT_MODULE,
  DEFAULT_WIRE,
  MUX_DEFAULT,
  WIRE_STYLES,
  DEFAULT_CANVAS_BG,
  DEFAULT_PORT_LABEL_SIZE,
  PORT_LABEL_SIZE_RANGE
} from './constants.js';
import { uid, clamp, getModuleById, applyCanvasBackground, applyPortLabelSize, ensureMuxGeometry } from './utils.js';
import { scheduleAutoSave } from './export.js';
import { setWireDefaultBend, setWireSmartBends } from './wire.js';
import { ensureMuxPorts } from './module.js';
import { describePortRef } from './port.js';
import { recordHistory } from './history.js';

/**
 * 创建表单字段
 */
function makeField(labelText, inputEl) {
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  field.appendChild(label);
  field.appendChild(inputEl);
  return field;
}

/**
 * 创建文本输入框
 */
function makeTextInput(value, onInput) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

/**
 * 创建数字输入框
 */
function makeNumberInput(value, options, onInput) {
  const input = document.createElement("input");
  input.type = "number";
  input.value = Number.isFinite(value) ? value : 0;
  if (options) {
    if (options.min !== undefined) input.min = options.min;
    if (options.max !== undefined) input.max = options.max;
    if (options.step !== undefined) input.step = options.step;
  }
  input.addEventListener("input", () => {
    const parsed = Number.parseFloat(input.value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    onInput(parsed);
  });
  return input;
}

/**
 * 创建复选框
 */
function makeCheckbox(value, onChange) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(value);
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

/**
 * 创建颜色输入框
 */
function makeColorInput(value, onInput) {
  const input = document.createElement("input");
  input.type = "color";
  input.value = value || DEFAULT_WIRE.color;
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

/**
 * 创建下拉选择框
 */
function makeSelect(options, value, onChange) {
  const select = document.createElement("select");
  options.forEach((option) => {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    if (option.value === value) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/**
 * 创建按钮
 */
function makeButton(label, className, onClick) {
  const button = document.createElement("button");
  button.textContent = label;
  if (className) {
    button.classList.add(className);
  }
  button.addEventListener("click", onClick);
  return button;
}

/**
 * 渲染画布属性
 */
function renderCanvasProperties(renderPropertiesCallback) {
  propertiesContent.appendChild(
    makeField(
      "Canvas Background",
      makeColorInput(state.canvasBackground || DEFAULT_CANVAS_BG, (value) => {
        state.canvasBackground = value;
        applyCanvasBackground();
        recordHistory();
        scheduleAutoSave();
      })
    )
  );

  const resetRow = document.createElement("div");
  resetRow.className = "action-row";
  resetRow.appendChild(
    makeButton("Reset Background", "btn-accent", () => {
      state.canvasBackground = "";
      applyCanvasBackground();
      recordHistory();
      scheduleAutoSave();
      if (renderPropertiesCallback) {
        renderPropertiesCallback();
      }
    })
  );
  propertiesContent.appendChild(resetRow);


  const portLabelMin = PORT_LABEL_SIZE_RANGE ? PORT_LABEL_SIZE_RANGE.min : 8;
  const portLabelMax = PORT_LABEL_SIZE_RANGE ? PORT_LABEL_SIZE_RANGE.max : 32;
  const portLabelInput = makeNumberInput(
    Number.isFinite(state.portLabelSize) ? state.portLabelSize : DEFAULT_PORT_LABEL_SIZE,
    { min: portLabelMin, max: portLabelMax, step: 1 },
    (value) => {
      const next = clamp(Math.round(value), portLabelMin, portLabelMax);
      state.portLabelSize = next;
      portLabelInput.value = next;
      applyPortLabelSize();
      recordHistory();
      scheduleAutoSave();
    }
  );
  propertiesContent.appendChild(makeField("Port Label Size", portLabelInput));
}

/**
 * 渲染模块属性
 */
function renderModuleProperties(mod, renderModulesCallback, updateWiresCallback, renderPropertiesCallback, updateStatusCallback) {
  propertiesContent.appendChild(
    makeField(
      "Name",
      makeTextInput(mod.name, (value) => {
        mod.name = value;
        renderModulesCallback();
      })
    )
  );

  const positionField = document.createElement("div");
  positionField.className = "field";
  const positionLabel = document.createElement("label");
  positionLabel.textContent = "Position";
  const positionRow = document.createElement("div");
  positionRow.className = "field-row";
  const xInput = makeNumberInput(Number.isFinite(mod.x) ? mod.x : 0, { step: 1 }, (value) => {
    mod.x = Math.round(value);
    xInput.value = mod.x;
    renderModulesCallback();
    updateWiresCallback();
  });
  xInput.placeholder = "X";
  xInput.title = "X position";
  const yInput = makeNumberInput(Number.isFinite(mod.y) ? mod.y : 0, { step: 1 }, (value) => {
    mod.y = Math.round(value);
    yInput.value = mod.y;
    renderModulesCallback();
    updateWiresCallback();
  });
  yInput.placeholder = "Y";
  yInput.title = "Y position";
  positionRow.appendChild(xInput);
  positionRow.appendChild(yInput);
  positionField.appendChild(positionLabel);
  positionField.appendChild(positionRow);
  propertiesContent.appendChild(positionField);

  const fillField = makeField(
    "Fill",
    makeColorInput(mod.fill || "#fffdf9", (value) => {
      mod.fill = value;
      renderModulesCallback();
    })
  );
  propertiesContent.appendChild(fillField);

  const strokeField = makeField(
    "Stroke Color",
    makeColorInput(mod.strokeColor || "#1d262b", (value) => {
      mod.strokeColor = value;
      renderModulesCallback();
    })
  );
  propertiesContent.appendChild(strokeField);

  const strokeWidthField = makeField(
    "Stroke Width",
    makeNumberInput(Number.isFinite(mod.strokeWidth) ? mod.strokeWidth : 2, { min: 0, max: 8, step: 0.2 }, (value) => {
      mod.strokeWidth = clamp(value, 0, 8);
      renderModulesCallback();
    })
  );
  propertiesContent.appendChild(strokeWidthField);

  const resetStyleRow = document.createElement("div");
  resetStyleRow.className = "action-row";
  resetStyleRow.appendChild(
    makeButton("Reset Style", "btn-accent", () => {
      mod.fill = DEFAULT_MODULE.fill;
      mod.strokeColor = DEFAULT_MODULE.strokeColor;
      mod.strokeWidth = DEFAULT_MODULE.strokeWidth;
      renderModulesCallback();
      renderPropertiesCallback();
    })
  );
  propertiesContent.appendChild(resetStyleRow);

  const nameSizeField = makeField(
    "Name Size",
    makeNumberInput(Number.isFinite(mod.nameSize) ? mod.nameSize : DEFAULT_MODULE.nameSize, { min: 10, max: 50, step: 1 }, (value) => {
      mod.nameSize = clamp(Math.round(value), 10, 50);
      renderModulesCallback();
    })
  );
  propertiesContent.appendChild(nameSizeField);

  const showTypeField = document.createElement("div");
  showTypeField.className = "field field-inline";
  const showTypeLabel = document.createElement("label");
  showTypeLabel.textContent = "Show Type";
  const showTypeInput = makeCheckbox(mod.showType !== false, (value) => {
    mod.showType = value;
    renderModulesCallback();
  });
  showTypeField.appendChild(showTypeLabel);
  showTypeField.appendChild(showTypeInput);
  propertiesContent.appendChild(showTypeField);

  propertiesContent.appendChild(
    makeField(
      "Type",
      makeSelect(
        Object.keys(MODULE_LIBRARY).map((key) => ({ value: key, label: MODULE_LIBRARY[key].label })),
        mod.type,
        (value) => {
          mod.type = value;
          if (value === "mux") {
            mod.muxInputs = MUX_DEFAULT.inputs;
            mod.muxControlSide = MUX_DEFAULT.controlSide;
            mod.ports = [];
            ensureMuxPorts(mod);
          }
          renderModulesCallback();
          updateWiresCallback();
          renderPropertiesCallback();
        }
      )
    )
  );

  if (mod.type === "mux") {
    const muxInputsField = makeField(
      "Mux Inputs",
      makeNumberInput(Number.isFinite(mod.muxInputs) ? mod.muxInputs : MUX_DEFAULT.inputs, { min: 2, max: 8, step: 1 }, (value) => {
        mod.muxInputs = clamp(Math.round(value), 2, 8);
        ensureMuxPorts(mod);
        renderModulesCallback();
        updateWiresCallback();
        renderPropertiesCallback();
      })
    );
    propertiesContent.appendChild(muxInputsField);

    const muxControlField = makeField(
      "Control Side",
      makeSelect(
        [
          { value: "top", label: "Top" },
          { value: "bottom", label: "Bottom" },
        ],
        mod.muxControlSide || MUX_DEFAULT.controlSide,
        (value) => {
          mod.muxControlSide = value;
          ensureMuxPorts(mod);
          renderModulesCallback();
          updateWiresCallback();
        }
      )
    );
    propertiesContent.appendChild(muxControlField);
  }

  const sizeField = document.createElement("div");
  sizeField.className = "field";
  const sizeLabel = document.createElement("label");
  sizeLabel.textContent = "Size";
  const sizeRow = document.createElement("div");
  sizeRow.className = "field-row";
  let heightInput;
  const widthInput = makeNumberInput(mod.width, { min: 40, max: 1000, step: 1 }, (value) => {
    mod.width = clamp(Math.round(value), 40, 1000);
    if (mod.type === "mux") {
      const beforeHeight = mod.height;
      ensureMuxGeometry(mod, "keepWidth");
      if (heightInput && mod.height !== beforeHeight) {
        heightInput.value = mod.height;
      }
    }
    renderModulesCallback();
    updateWiresCallback();
  });
  heightInput = makeNumberInput(mod.height, { min: 60, max: 1200, step: 1 }, (value) => {
    mod.height = clamp(Math.round(value), 60, 1200);
    if (mod.type === "mux") {
      const beforeWidth = mod.width;
      const beforeHeight = mod.height;
      ensureMuxGeometry(mod, "keepHeight");
      if (mod.width !== beforeWidth) {
        widthInput.value = mod.width;
      }
      if (mod.height !== beforeHeight) {
        heightInput.value = mod.height;
      }
    }
    renderModulesCallback();
    updateWiresCallback();
  });
  sizeRow.appendChild(widthInput);
  sizeRow.appendChild(heightInput);
  sizeField.appendChild(sizeLabel);
  sizeField.appendChild(sizeRow);
  propertiesContent.appendChild(sizeField);

  const portsField = document.createElement("div");
  portsField.className = "field";
  const portsLabel = document.createElement("label");
  portsLabel.textContent = "Ports";
  portsField.appendChild(portsLabel);

  const portList = document.createElement("div");
  portList.className = "port-list";

  mod.ports.forEach((port) => {
    const row = document.createElement("div");
    row.className = "port-row";

    const nameInput = makeTextInput(port.name, (value) => {
      port.name = value;
      renderModulesCallback();
    });

    const isClockPort = mod.type === "reg" && (port.clock === true || port.name === "CLK");
    const sideOptions = isClockPort
      ? [
        { value: "top", label: "Top" },
        { value: "bottom", label: "Bottom" },
      ]
      : [
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
        { value: "top", label: "Top" },
        { value: "bottom", label: "Bottom" },
      ];
    const sideSelect = makeSelect(sideOptions, port.side, (value) => {
      port.side = value;
      renderModulesCallback();
      updateWiresCallback();
    });

    const offsetInput = makeNumberInput(Math.round(port.offset * 100), { min: 0, max: 100, step: 1 }, (value) => {
      port.offset = clamp(value / 100, 0, 1);
      renderModulesCallback();
      updateWiresCallback();
    });

    const removeButton = makeButton("Remove", "", () => {
      mod.ports = mod.ports.filter((item) => item.id !== port.id);
      state.wires = state.wires.filter((wire) => wire.from.portId !== port.id && wire.to.portId !== port.id);
      state.connecting = null;
      renderModulesCallback();
      updateWiresCallback();
      renderPropertiesCallback();
      updateStatusCallback();
    });

    row.appendChild(nameInput);
    row.appendChild(sideSelect);
    row.appendChild(offsetInput);
    row.appendChild(removeButton);
    portList.appendChild(row);
  });

  portsField.appendChild(portList);

  const addPort = makeButton("Add Port", "btn-accent", () => {
    mod.ports.push({
      id: uid("port"),
      name: `P${mod.ports.length + 1}`,
      side: "left",
      offset: 0.5,
    });
    renderModulesCallback();
    updateWiresCallback();
    renderPropertiesCallback();
  });

  portsField.appendChild(addPort);
  propertiesContent.appendChild(portsField);

  const actionRow = document.createElement("div");
  actionRow.className = "action-row";
  actionRow.appendChild(
    makeButton("Delete Module", "danger", () => {
      state.modules = state.modules.filter((item) => item.id !== mod.id);
      state.wires = state.wires.filter((wire) => wire.from.moduleId !== mod.id && wire.to.moduleId !== mod.id);
      state.selection = null;
      state.connecting = null;
      renderModulesCallback();
      updateWiresCallback();
      renderPropertiesCallback();
      updateStatusCallback();
    })
  );
  propertiesContent.appendChild(actionRow);
}

/**
 * 渲染连线属性
 */
function renderWireProperties(wire, updateWiresCallback, renderPropertiesCallback, updateStatusCallback, renderModulesCallback) {
  const labelField = makeField(
    "Label",
    makeTextInput(wire.label, (value) => {
      wire.label = value;
      updateWiresCallback();
    })
  );
  propertiesContent.appendChild(labelField);

  const labelAtValue = wire.labelAt === "start" ? "start" : "end";
  wire.labelAt = labelAtValue;
  const labelPositionField = makeField(
    "Label Position",
    makeSelect(
      [
        { value: "end", label: "End port" },
        { value: "start", label: "Start port" },
      ],
      labelAtValue,
      (value) => {
        wire.labelAt = value;
        updateWiresCallback();
      }
    )
  );
  propertiesContent.appendChild(labelPositionField);

  const colorField = makeField(
    "Color",
    makeColorInput(wire.color || DEFAULT_WIRE.color, (value) => {
      wire.color = value;
      updateWiresCallback();
    })
  );
  propertiesContent.appendChild(colorField);

  const widthField = makeField(
    "Width",
    makeNumberInput(Number.isFinite(wire.width) ? wire.width : DEFAULT_WIRE.width, { min: 1, max: 12, step: 0.2 }, (value) => {
      wire.width = clamp(value, 1, 12);
      updateWiresCallback();
    })
  );
  propertiesContent.appendChild(widthField);

  const styleField = makeField(
    "Line Style",
    makeSelect(
      [
        { value: "solid", label: "Solid" },
        { value: "dashed", label: "Dashed" },
        { value: "dotted", label: "Dotted" },
      ],
      wire.style || DEFAULT_WIRE.style,
      (value) => {
        wire.style = value;
        updateWiresCallback();
      }
    )
  );
  propertiesContent.appendChild(styleField);

  const routeField = makeField(
    "Route",
    makeSelect(
      [
        { value: "H", label: "Horizontal first" },
        { value: "V", label: "Vertical first" },
      ],
      wire.route,
      (value) => {
        wire.route = value;
        setWireDefaultBend(wire);
        wire.bends = null;
        updateWiresCallback();
        renderPropertiesCallback();
      }
    )
  );
  propertiesContent.appendChild(routeField);

  if (Array.isArray(wire.bends) && wire.bends.length > 0) {
    const bendsField = document.createElement("div");
    bendsField.className = "field";
    const bendsLabel = document.createElement("label");
    bendsLabel.textContent = "Bend Points";
    bendsField.appendChild(bendsLabel);

    const bendsList = document.createElement("div");
    bendsList.className = "port-list";

    wire.bends.forEach((bend, index) => {
      const row = document.createElement("div");
      row.className = "port-row";

      const label = document.createElement("span");
      label.textContent = `Point ${index + 1}`;
      label.style.fontSize = "12px";
      label.style.color = "var(--muted)";

      const xInput = makeNumberInput(bend.x, { step: 1 }, (value) => {
        wire.bends[index].x = Math.round(value);
        updateWiresCallback();
      });
      xInput.placeholder = "X";
      xInput.title = "X position";

      const yInput = makeNumberInput(bend.y, { step: 1 }, (value) => {
        wire.bends[index].y = Math.round(value);
        updateWiresCallback();
      });
      yInput.placeholder = "Y";
      yInput.title = "Y position";

      row.appendChild(label);
      row.appendChild(xInput);
      row.appendChild(yInput);
      bendsList.appendChild(row);
    });

    bendsField.appendChild(bendsList);
    propertiesContent.appendChild(bendsField);

    const resetRouteRow = document.createElement("div");
    resetRouteRow.className = "action-row";
    resetRouteRow.appendChild(
      makeButton("Reset to Simple Route", "btn-accent", () => {
        wire.bends = null;
        setWireDefaultBend(wire);
        updateWiresCallback();
        renderPropertiesCallback();
      })
    );
    propertiesContent.appendChild(resetRouteRow);

    const recomputeRow = document.createElement("div");
    recomputeRow.className = "action-row";
    recomputeRow.appendChild(
      makeButton("Recompute Smart Route", "btn-accent", () => {
        wire.bends = null;
        setWireDefaultBend(wire);
        setWireSmartBends(wire);
        updateWiresCallback();
        renderPropertiesCallback();
      })
    );
    propertiesContent.appendChild(recomputeRow);
  } else {
    const bendField = makeField(
      "Bend (px)",
      makeNumberInput(wire.bend, { step: 1 }, (value) => {
        wire.bend = Math.round(value);
        updateWiresCallback();
      })
    );
    propertiesContent.appendChild(bendField);

    const smartRouteRow = document.createElement("div");
    smartRouteRow.className = "action-row";
    smartRouteRow.appendChild(
      makeButton("Enable Smart Route", "btn-accent", () => {
        setWireSmartBends(wire);
        updateWiresCallback();
        renderPropertiesCallback();
      })
    );
    propertiesContent.appendChild(smartRouteRow);
  }

  const meta = document.createElement("div");
  meta.className = "empty-state";
  meta.textContent = `${describePortRef(wire.from)} -> ${describePortRef(wire.to)}`;
  propertiesContent.appendChild(meta);

  const actionRow = document.createElement("div");
  actionRow.className = "action-row";
  actionRow.appendChild(
    makeButton("Delete Wire", "danger", () => {
      state.wires = state.wires.filter((item) => item.id !== wire.id);
      state.selection = null;
      renderModulesCallback();
      updateWiresCallback();
      renderPropertiesCallback();
      updateStatusCallback();
    })
  );
  propertiesContent.appendChild(actionRow);
}

/**
 * 渲染属性面板
 */
export function renderProperties(renderModulesCallback, updateWiresCallback, updateStatusCallback) {
  const renderModules = () => {
    renderModulesCallback();
    recordHistory();
    scheduleAutoSave();
  };
  const updateWires = () => {
    updateWiresCallback();
    recordHistory();
    scheduleAutoSave();
  };
  const renderPropertiesCallback = () => renderProperties(renderModulesCallback, updateWiresCallback, updateStatusCallback);

  propertiesContent.innerHTML = "";

  if (!state.selection) {
    renderCanvasProperties(renderPropertiesCallback);
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Select a module or wire to edit its properties. Drag modules from the palette to start.";
    propertiesContent.appendChild(empty);
    return;
  }

  if (state.selection.type === "module") {
    const mod = getModuleById(state.selection.id);
    if (mod) {
      renderModuleProperties(mod, renderModules, updateWires, renderPropertiesCallback, updateStatusCallback);
    }
    return;
  }

  if (state.selection.type === "wire") {
    const wire = state.wires.find((item) => item.id === state.selection.id);
    if (wire) {
      renderWireProperties(wire, updateWires, renderPropertiesCallback, updateStatusCallback, renderModules);
    }
  }
}
