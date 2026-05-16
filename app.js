import { PACKETS, resolvePacket, initialState } from "./packets.js";
import { renderPacket } from "./renderer.js";
import { toJson, fromJson } from "./formats/json.js";
import { toAscii } from "./formats/rfc-ascii.js";
import { fromAad } from "./formats/aug-ascii.js";

// Runtime registry for imported packets — kept separate from the static
// PACKETS so imported entries don't bleed into the built-in presets and
// can be referenced via synthetic keys like "imported:My Packet".
const importedPackets = {};

function getPacket(key) {
  return PACKETS[key] || importedPackets[key];
}

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
  btnImport: document.getElementById("btn-import"),
  btnExport: document.getElementById("btn-export"),
  modalOverlay: document.getElementById("modal-overlay"),
  modalClose: document.getElementById("modal-close"),
  modalMode: document.getElementById("modal-mode"),
  modalFormat: document.getElementById("modal-format"),
  modalText: document.getElementById("modal-text"),
  modalStatus: document.getElementById("modal-status"),
  modalGenerate: document.getElementById("modal-generate"),
  modalApply: document.getElementById("modal-apply"),
  modalCopy: document.getElementById("modal-copy"),
};

function init() {
  rebuildSelector();
  els.selector.value = state.packetKey;
  els.selector.addEventListener("change", (e) => {
    state.packetKey = e.target.value;
    state.controllers = initialState(getPacket(state.packetKey));
    state.selectedFieldId = null;
    render();
  });

  initThemeToggle();
  state.controllers = initialState(getPacket(state.packetKey));
  initModal();
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

function rebuildSelector() {
  els.selector.innerHTML = "";
  const addGroup = (label, entries) => {
    if (!entries.length) return;
    const grp = document.createElement("optgroup");
    grp.label = label;
    for (const [key, packet] of entries) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = packet.name;
      grp.appendChild(opt);
    }
    els.selector.appendChild(grp);
  };
  addGroup("Built-in", Object.entries(PACKETS));
  addGroup("Imported", Object.entries(importedPackets));
}

function render() {
  const packet = getPacket(state.packetKey);
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

// ---------------- Import / Export modal ----------------

function initModal() {
  els.btnImport.addEventListener("click", () => openModal("import"));
  els.btnExport.addEventListener("click", () => openModal("export"));
  els.modalClose.addEventListener("click", closeModal);
  els.modalOverlay.addEventListener("click", (e) => {
    if (e.target === els.modalOverlay) closeModal();
  });
  els.modalMode.addEventListener("change", syncModalUi);
  els.modalFormat.addEventListener("change", syncModalUi);
  els.modalGenerate.addEventListener("click", onGenerate);
  els.modalApply.addEventListener("click", onApply);
  els.modalCopy.addEventListener("click", onCopy);
}

function openModal(mode) {
  els.modalMode.value = mode;
  // Default format per mode.
  if (mode === "import") {
    els.modalFormat.value = "json";
  } else {
    els.modalFormat.value = "json";
  }
  els.modalText.value = "";
  setStatus("");
  syncModalUi();
  els.modalOverlay.hidden = false;
  if (mode === "export") onGenerate();
}

function closeModal() {
  els.modalOverlay.hidden = true;
}

function syncModalUi() {
  const mode = els.modalMode.value;
  const fmt = els.modalFormat.value;
  // Format constraints: rfc-ascii is export-only, aug-ascii is import-only.
  if (mode === "import" && fmt === "rfc-ascii") {
    els.modalFormat.value = "json";
  } else if (mode === "export" && fmt === "aug-ascii") {
    els.modalFormat.value = "json";
  }
  // Toggle button visibility.
  const importMode = els.modalMode.value === "import";
  els.modalApply.style.display    = importMode ? "" : "none";
  els.modalGenerate.style.display = importMode ? "none" : "";
  els.modalCopy.style.display     = importMode ? "none" : "";
  els.modalText.placeholder = importMode
    ? "Paste packet definition here, then click Apply."
    : "Click Generate to populate from the active packet.";
}

function onGenerate() {
  try {
    const packet = getPacket(state.packetKey);
    const fmt = els.modalFormat.value;
    if (fmt === "json") {
      els.modalText.value = toJson(packet, state.controllers);
    } else if (fmt === "rfc-ascii") {
      els.modalText.value = toAscii(packet, state.controllers);
    } else {
      throw new Error(`Unsupported export format: ${fmt}`);
    }
    setStatus(`Generated ${fmt}.`, "ok");
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, "error");
  }
}

function onApply() {
  const fmt = els.modalFormat.value;
  const text = els.modalText.value;
  try {
    let packet, controllers, warnings = [];
    if (fmt === "json") {
      ({ packet, controllers } = fromJson(text));
    } else if (fmt === "aug-ascii") {
      ({ packet, controllers, warnings } = fromAad(text));
    } else {
      throw new Error(`Format "${fmt}" cannot be imported.`);
    }
    const key = `imported:${packet.name}`;
    importedPackets[key] = packet;
    state.packetKey = key;
    state.controllers = { ...initialState(packet), ...controllers };
    state.selectedFieldId = null;
    rebuildSelector();
    els.selector.value = key;
    render();
    if (warnings.length) {
      setStatus(`Imported with warnings: ${warnings.join("; ")}`, "warn");
    } else {
      setStatus("Imported.", "ok");
      closeModal();
    }
  } catch (e) {
    setStatus(`Import failed: ${e.message}`, "error");
  }
}

async function onCopy() {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(els.modalText.value);
    } else {
      els.modalText.select();
      document.execCommand("copy");
    }
    setStatus("Copied to clipboard.", "ok");
  } catch (e) {
    setStatus(`Copy failed: ${e.message}`, "error");
  }
}

function setStatus(msg, kind) {
  els.modalStatus.textContent = msg || "";
  els.modalStatus.className = "modal-status" + (kind ? ` ${kind}` : "");
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
