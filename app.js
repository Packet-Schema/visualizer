import { PACKETS, resolvePacket, initialState } from "./packets.js";
import { renderPacket } from "./renderer.js";

const THEME_STORAGE_KEY = "packet-view-theme";

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
  themeToggle: document.getElementById("theme-toggle"),
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

  initThemeToggle();

  state.controllers = initialState(PACKETS[state.packetKey]);
  render();
}

function initThemeToggle() {
  if (!els.themeToggle) return;

  const updateButtonState = () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    els.themeToggle.setAttribute("aria-pressed", current === "dark" ? "true" : "false");
    els.themeToggle.setAttribute(
      "aria-label",
      current === "dark" ? "Switch to light theme" : "Switch to dark theme"
    );
  };

  updateButtonState();

  els.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (e) {
      // ignore — storage may be disabled
    }
    updateButtonState();
  });

  // If the user has not explicitly set a preference, follow OS changes.
  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (e) => {
      let stored = null;
      try { stored = localStorage.getItem(THEME_STORAGE_KEY); } catch (_) {}
      if (stored) return;
      document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
      updateButtonState();
    };
    if (mql.addEventListener) mql.addEventListener("change", listener);
    else if (mql.addListener) mql.addListener(listener);
  }
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
    onSubfieldClick: (parentField, subfield) => {
      state.selectedFieldId = `${parentField.id}:${subfield.id}`;
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
    slider.setAttribute("aria-label", `${field.name} value`);

    const number = document.createElement("input");
    number.type = "number";
    number.min = slider.min;
    number.max = slider.max;
    number.value = value;
    number.className = "control-number";
    number.setAttribute("aria-label", `${field.name} numeric input`);

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

  // Subfield selection has the form "parentId:subfieldId".
  if (state.selectedFieldId.includes(":")) {
    const [parentId, subId] = state.selectedFieldId.split(":");
    const parent = packet.fields.find(f => f.id === parentId);
    const sub = parent && parent.subfields
      ? parent.subfields.find(s => s.id === subId)
      : null;
    if (!parent || !sub) {
      els.detail.innerHTML = `<p class="muted">Subfield not found.</p>`;
      return;
    }
    const bits = sub.bits;
    els.detail.innerHTML = `
      <h3>${escapeHtml(sub.name)} <span class="subfield-hint">(subfield of ${escapeHtml(parent.name)})</span></h3>
      <dl>
        <dt>Size</dt><dd>${bits} bit${bits === 1 ? "" : "s"}</dd>
        <dt>Parent</dt><dd>${escapeHtml(parent.name)} (${parent.bits} bits)</dd>
        ${sub.description ? `<dt>Description</dt><dd>${escapeHtml(sub.description)}</dd>` : ""}
      </dl>
    `;
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

  const subfieldsHtml = field.subfields
    ? `<dt>Subfields</dt><dd>${field.subfields.map(s => `<code>${escapeHtml(s.name)}</code> (${s.bits}b)`).join(" ")}</dd>`
    : "";

  els.detail.innerHTML = `
    <h3>${escapeHtml(field.name)}</h3>
    <dl>
      <dt>Size</dt><dd><span class="mono">${bits} bits${Number.isInteger(bits / 8) ? ` (${bits / 8} bytes)` : ""}</span>${field.variable ? " <em>(variable)</em>" : ""}</dd>
      ${field.variable ? `<dt>Driven by</dt><dd><code>${escapeHtml(field.lengthFrom)}</code></dd>` : ""}
      ${field.controlsLength ? `<dt>Controls</dt><dd><code>${escapeHtml(field.controlsLength)}</code> (current: <span class="mono">${state.controllers[field.controlsLength]}</span>)</dd>` : ""}
      ${field.description ? `<dt>Description</dt><dd>${escapeHtml(field.description)}</dd>` : ""}
      ${subfieldsHtml}
    </dl>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

init();
