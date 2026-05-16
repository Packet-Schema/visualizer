import { PACKETS, resolvePacket, initialState } from "./packets.js";
import { renderPacket } from "./renderer.js";

const state = {
  packetKey: "ipv4",
  controllers: {},        // controller key -> numeric value
  selectedFieldId: null,
};

const els = {
  selector: document.getElementById("packet-selector"),
  description: document.getElementById("packet-description"),
  diagram: document.getElementById("diagram"),
  controls: document.getElementById("controls"),
  detail: document.getElementById("detail"),
  summary: document.getElementById("summary"),
};

function init() {
  // Populate selector
  for (const [key, packet] of Object.entries(PACKETS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = packet.name;
    els.selector.appendChild(opt);
  }
  els.selector.value = state.packetKey;
  els.selector.addEventListener("change", (e) => {
    state.packetKey = e.target.value;
    state.controllers = initialState(PACKETS[state.packetKey]);
    state.selectedFieldId = null;
    render();
  });

  state.controllers = initialState(PACKETS[state.packetKey]);
  render();
}

function render() {
  const packet = PACKETS[state.packetKey];
  const layout = resolvePacket(packet, state.controllers);

  // Description
  els.description.textContent = packet.description || "";

  // Diagram
  els.diagram.innerHTML = "";
  const svg = renderPacket(packet, layout, {
    selectedFieldId: state.selectedFieldId,
    onFieldClick: (field) => {
      state.selectedFieldId = field.id;
      render();
    },
  });
  els.diagram.appendChild(svg);

  // Controls (variable-length controllers)
  renderControls(packet);

  // Detail
  renderDetail(packet);

  // Summary line
  const bytes = layout.totalBits / 8;
  const byteStr = Number.isInteger(bytes) ? `${bytes} bytes` : `${layout.totalBits} bits`;
  els.summary.textContent = `Header size: ${layout.totalBits} bits (${byteStr})`;
}

function renderControls(packet) {
  els.controls.innerHTML = "";
  const controllers = packet.fields.filter(f => f.controlsLength);
  if (controllers.length === 0) {
    els.controls.innerHTML = `<p class="muted">This packet has no variable-length controllers.</p>`;
    return;
  }
  for (const field of controllers) {
    const value = state.controllers[field.controlsLength];

    const wrap = document.createElement("div");
    wrap.className = "control";

    const label = document.createElement("label");
    label.innerHTML = `
      <span class="control-name">${field.name}</span>
      <span class="control-hint">${field.description || ""}</span>
    `;
    wrap.appendChild(label);

    const row = document.createElement("div");
    row.className = "control-row";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = field.min ?? 0;
    slider.max = field.max ?? (2 ** field.bits - 1);
    slider.value = value;

    const number = document.createElement("input");
    number.type = "number";
    number.min = slider.min;
    number.max = slider.max;
    number.value = value;
    number.className = "control-number";

    const apply = (v) => {
      const clamped = Math.max(Number(slider.min), Math.min(Number(slider.max), Number(v)));
      state.controllers[field.controlsLength] = clamped;
      slider.value = clamped;
      number.value = clamped;
      render();
    };
    slider.addEventListener("input", e => apply(e.target.value));
    number.addEventListener("change", e => apply(e.target.value));

    row.appendChild(slider);
    row.appendChild(number);
    wrap.appendChild(row);
    els.controls.appendChild(wrap);
  }
}

function renderDetail(packet) {
  if (!state.selectedFieldId) {
    els.detail.innerHTML = `<p class="muted">Click a field in the diagram to see its details.</p>`;
    return;
  }
  const field = packet.fields.find(f => f.id === state.selectedFieldId);
  if (!field) {
    els.detail.innerHTML = `<p class="muted">Field not found.</p>`;
    return;
  }
  const bits = field.variable
    ? field.toBits(state.controllers[field.lengthFrom])
    : field.bits;

  els.detail.innerHTML = `
    <h3>${escapeHtml(field.name)}</h3>
    <dl>
      <dt>Size</dt><dd>${bits} bits${Number.isInteger(bits / 8) ? ` (${bits / 8} bytes)` : ""}${field.variable ? " <em>(variable)</em>" : ""}</dd>
      ${field.variable ? `<dt>Driven by</dt><dd><code>${escapeHtml(field.lengthFrom)}</code></dd>` : ""}
      ${field.controlsLength ? `<dt>Controls</dt><dd><code>${escapeHtml(field.controlsLength)}</code> (current: ${state.controllers[field.controlsLength]})</dd>` : ""}
      ${field.description ? `<dt>Description</dt><dd>${escapeHtml(field.description)}</dd>` : ""}
    </dl>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

init();
