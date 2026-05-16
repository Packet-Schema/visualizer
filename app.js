import {
  PACKETS, resolvePacket, initialState,
  CATEGORY_LABELS, DEFAULT_BYTE_ORDER, packetCategories,
} from "./packets.js";
import { renderPacket, CATEGORY_TO_TOKEN, tokenToCssVar } from "./renderer.js";
import { annotateAcronyms } from "./glossary.js";
import { toJson, fromJson } from "./formats/json.js";
import { toAscii } from "./formats/rfc-ascii.js";
import { fromAad } from "./formats/aug-ascii.js";
import { toWorksheet } from "./formats/worksheet.js";

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
  filter: document.getElementById("packet-filter"),
  description: document.getElementById("packet-description"),
  byteOrderNote: document.getElementById("byte-order-note"),
  diagram: document.getElementById("diagram"),
  legend: document.getElementById("legend"),
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
  modalWorksheetAnswers: document.getElementById("modal-worksheet-answers"),
  modalWorksheetLabel: document.querySelector(".worksheet-only"),
};

// Curriculum-ordered grouping of built-in presets by OSI layer.
// Keys must match PACKETS keys in packets.js.
const PRESET_GROUPS = [
  { label: "Layer 2 — Link",        keys: ["ethernet", "vlan"] },
  { label: "Layer 3 — Network",     keys: ["ipv4", "ipv6", "arp", "icmp", "icmpv6"] },
  { label: "Layer 4 — Transport",   keys: ["tcp", "udp"] },
  { label: "Application",           keys: ["dns", "tlsRecord", "quicShort"] },
];

function init() {
  rebuildSelector();
  els.selector.value = state.packetKey;
  els.selector.addEventListener("change", (e) => {
    state.packetKey = e.target.value;
    state.controllers = initialState(getPacket(state.packetKey));
    state.selectedFieldId = null;
    render();
  });

  if (els.filter) {
    els.filter.addEventListener("input", () => {
      rebuildSelector(els.filter.value);
      // Preserve selection if still visible; else fall back to first option.
      if (els.selector.querySelector(`option[value="${cssEscape(state.packetKey)}"]`)) {
        els.selector.value = state.packetKey;
      } else if (els.selector.options.length > 0) {
        // Don't change state.packetKey from a filter; just visually focus first.
        els.selector.selectedIndex = 0;
      }
    });
  }

  initThemeToggle();
  state.controllers = initialState(getPacket(state.packetKey));
  initModal();
  render();
  initDiagramKeyboardNav();
}

// Minimal CSS.escape polyfill for attribute selectors built from preset keys.
function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
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

function rebuildSelector(filterText = "") {
  els.selector.innerHTML = "";
  const needle = filterText.trim().toLowerCase();
  const matches = (packet) => !needle || packet.name.toLowerCase().includes(needle);

  const addGroup = (label, entries) => {
    const visible = entries.filter(([_, packet]) => matches(packet));
    if (!visible.length) return;
    const grp = document.createElement("optgroup");
    grp.label = label;
    for (const [key, packet] of visible) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = packet.name;
      grp.appendChild(opt);
    }
    els.selector.appendChild(grp);
  };

  // Built-in groups in curriculum order.
  const seen = new Set();
  for (const group of PRESET_GROUPS) {
    const entries = group.keys
      .filter((k) => PACKETS[k])
      .map((k) => {
        seen.add(k);
        return [k, PACKETS[k]];
      });
    addGroup(group.label, entries);
  }
  // Any built-in preset not assigned to an OSI group lands here so we never
  // silently drop a new packet that someone forgets to categorise.
  const ungrouped = Object.entries(PACKETS).filter(([k]) => !seen.has(k));
  if (ungrouped.length) addGroup("Other", ungrouped);

  addGroup("Imported", Object.entries(importedPackets));
}

function render() {
  const packet = getPacket(state.packetKey);
  const layout = resolvePacket(packet, state.controllers);

  // Description
  els.description.textContent = packet.description || "";

  // Per-packet endianness / byte-order note
  if (els.byteOrderNote) {
    els.byteOrderNote.textContent = packet.byteOrder || DEFAULT_BYTE_ORDER;
  }

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

  // Legend (categories present in the currently rendered packet)
  renderLegend(packet);

  // Controls (variable-length controllers)
  renderControls(packet);

  // Detail
  renderDetail(packet);

  // Summary line
  const bytes = layout.totalBits / 8;
  const byteStr = Number.isInteger(bytes) ? `${bytes} bytes` : `${layout.totalBits} bits`;
  els.summary.textContent = `Header size: ${layout.totalBits} bits (${byteStr})`;
}

function renderLegend(packet) {
  if (!els.legend) return;
  const categories = packetCategories(packet);
  els.legend.innerHTML = "";
  if (categories.length === 0) {
    els.legend.hidden = true;
    return;
  }
  els.legend.hidden = false;

  const heading = document.createElement("h2");
  heading.textContent = "Legend";
  els.legend.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "legend-list";
  for (const cat of categories) {
    const token = CATEGORY_TO_TOKEN[cat];
    const label = CATEGORY_LABELS[cat] || cat;
    const li = document.createElement("li");
    li.className = "legend-item";

    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = tokenToCssVar(token);
    swatch.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "legend-label";
    text.textContent = label;

    li.appendChild(swatch);
    li.appendChild(text);
    list.appendChild(li);
  }
  els.legend.appendChild(list);
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
    const baseId = `ctrl-${field.id}`;
    const sliderId = `${baseId}-slider`;
    const numberId = `${baseId}-number`;
    const labelId = `${baseId}-label`;
    const hintId = `${baseId}-hint`;

    const wrap = document.createElement("div");
    wrap.className = "control";

    // Visible label is a real <label for=...> targeting the slider, with an
    // id so screen-readers can also reference it via aria-labelledby on the
    // numeric input. The hint paragraph carries an id used by aria-describedby.
    const label = document.createElement("label");
    label.setAttribute("for", sliderId);
    label.id = labelId;
    label.className = "control-label";
    const nameSpan = document.createElement("span");
    nameSpan.className = "control-name";
    nameSpan.textContent = field.name;
    label.appendChild(nameSpan);
    wrap.appendChild(label);

    if (field.description) {
      const hint = document.createElement("span");
      hint.className = "control-hint";
      hint.id = hintId;
      hint.textContent = field.description;
      wrap.appendChild(hint);
    }

    const row = document.createElement("div");
    row.className = "control-row";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.id = sliderId;
    slider.min = field.min ?? 0;
    slider.max = field.max ?? (2 ** field.bits - 1);
    slider.value = value;
    if (field.description) slider.setAttribute("aria-describedby", hintId);

    const number = document.createElement("input");
    number.type = "number";
    number.id = numberId;
    number.min = slider.min;
    number.max = slider.max;
    number.value = value;
    number.className = "control-number";
    number.setAttribute("aria-labelledby", labelId);
    if (field.description) number.setAttribute("aria-describedby", hintId);

    // aria-valuetext gives a richer announcement than the bare numeric value
    // (e.g. "IHL: 5 (header is 20 bytes)"). Use the variable-length
    // dependent-field byte count when available.
    const updateValueText = (v) => {
      const dependent = packet.fields.find(
        f => f.variable && f.lengthFrom === field.controlsLength,
      );
      let suffix = "";
      if (dependent && typeof dependent.toBits === "function") {
        const baseBits = packet.fields
          .filter(f => !f.variable && typeof f.bits === "number")
          .reduce((acc, f) => acc + f.bits, 0);
        const totalBits = baseBits + dependent.toBits(Number(v));
        if (Number.isInteger(totalBits / 8)) {
          suffix = ` (header is ${totalBits / 8} bytes)`;
        } else {
          suffix = ` (header is ${totalBits} bits)`;
        }
      }
      slider.setAttribute("aria-valuetext", `${field.name}: ${v}${suffix}`);
    };
    updateValueText(value);

    const apply = (v) => {
      const clamped = Math.max(Number(slider.min), Math.min(Number(slider.max), Number(v)));
      state.controllers[field.controlsLength] = clamped;
      slider.value = clamped;
      number.value = clamped;
      updateValueText(clamped);
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

// Element to restore focus to when the modal closes.
let modalReturnFocusEl = null;

function initModal() {
  els.btnImport.addEventListener("click", () => openModal("import"));
  els.btnExport.addEventListener("click", () => openModal("export"));
  els.modalClose.addEventListener("click", closeModal);
  els.modalOverlay.addEventListener("click", (e) => {
    if (e.target === els.modalOverlay) closeModal();
  });
  els.modalMode.addEventListener("change", syncModalUi);
  els.modalFormat.addEventListener("change", syncModalUi);
  if (els.modalWorksheetAnswers) {
    els.modalWorksheetAnswers.addEventListener("change", () => {
      // No auto-generate; the user clicks Generate to spawn a new tab.
    });
  }
  els.modalGenerate.addEventListener("click", onGenerate);
  els.modalApply.addEventListener("click", onApply);
  els.modalCopy.addEventListener("click", onCopy);

  // Esc to close + Tab focus trap. Bound to the overlay so it only fires while
  // the modal is rendered (overlay carries `hidden` when closed).
  els.modalOverlay.addEventListener("keydown", handleModalKeydown);
}

// Returns visible, focusable elements within the modal in DOM order.
function getModalFocusables() {
  const sel = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type=hidden])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");
  return Array.from(els.modalOverlay.querySelectorAll(sel)).filter((el) => {
    if (el.hidden) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  });
}

function handleModalKeydown(e) {
  if (els.modalOverlay.hidden) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeModal();
    return;
  }
  if (e.key === "Tab") {
    const focusables = getModalFocusables();
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !els.modalOverlay.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !els.modalOverlay.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  }
}

function openModal(mode) {
  // Remember opener so we can return focus on close.
  modalReturnFocusEl = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

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

  // Move focus to the first interactive element inside the modal.
  const focusables = getModalFocusables();
  if (focusables.length > 0) focusables[0].focus();
}

function closeModal() {
  els.modalOverlay.hidden = true;
  // Return focus to the opener (or any saved element). Guard against the
  // saved element having been removed from the DOM.
  if (modalReturnFocusEl && document.contains(modalReturnFocusEl)) {
    try { modalReturnFocusEl.focus(); } catch (_) { /* ignore */ }
  }
  modalReturnFocusEl = null;
}

function syncModalUi() {
  const mode = els.modalMode.value;
  const fmt = els.modalFormat.value;
  // Format constraints:
  //   rfc-ascii  -> export only
  //   worksheet  -> export only
  //   aug-ascii  -> import only
  if (mode === "import" && (fmt === "rfc-ascii" || fmt === "worksheet")) {
    els.modalFormat.value = "json";
  } else if (mode === "export" && fmt === "aug-ascii") {
    els.modalFormat.value = "json";
  }
  // Toggle button visibility.
  const importMode = els.modalMode.value === "import";
  const isWorksheet = !importMode && els.modalFormat.value === "worksheet";
  els.modalApply.style.display    = importMode ? "" : "none";
  els.modalGenerate.style.display = importMode ? "none" : "";
  // The Copy button is meaningless for worksheet (we open a new tab instead).
  els.modalCopy.style.display     = (importMode || isWorksheet) ? "none" : "";
  if (els.modalWorksheetLabel) {
    els.modalWorksheetLabel.hidden = !isWorksheet;
  }
  if (isWorksheet) {
    els.modalText.placeholder = "Click Generate to open the worksheet in a new tab.";
  } else {
    els.modalText.placeholder = importMode
      ? "Paste packet definition here, then click Apply."
      : "Click Generate to populate from the active packet.";
  }
  // Don't auto-fill the textarea with the worksheet HTML on switch.
  if (isWorksheet) els.modalText.value = "";
}

function onGenerate() {
  try {
    const packet = getPacket(state.packetKey);
    const fmt = els.modalFormat.value;
    if (fmt === "json") {
      els.modalText.value = toJson(packet, state.controllers);
    } else if (fmt === "rfc-ascii") {
      els.modalText.value = toAscii(packet, state.controllers);
    } else if (fmt === "worksheet") {
      const withAnswers = !!(els.modalWorksheetAnswers && els.modalWorksheetAnswers.checked);
      const html = toWorksheet(packet, state.controllers, { withAnswers });
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const w = window.open(url, "_blank");
      if (!w) {
        // Pop-up blocked: leave the URL accessible in the textarea so the
        // user can copy/open it manually.
        els.modalText.value = url;
        setStatus("Pop-up blocked. Copy the URL above and open it manually.", "warn");
        return;
      }
      // Revoke after a short delay so the new tab can finish loading.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      els.modalText.value = `(opened ${withAnswers ? "answer key" : "worksheet"} in a new tab)`;
      setStatus(`Worksheet opened${withAnswers ? " with answers" : ""}.`, "ok");
      return;
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
        ${sub.description ? `<dt>Description</dt><dd>${enrichDescription(sub.description)}</dd>` : ""}
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

  const categoryHtml = field.category
    ? `<dt>Category</dt><dd>${escapeHtml(CATEGORY_LABELS[field.category] || field.category)}</dd>`
    : "";

  els.detail.innerHTML = `
    <h3>${escapeHtml(field.name)}</h3>
    <dl>
      <dt>Size</dt><dd><span class="mono">${bits} bits${Number.isInteger(bits / 8) ? ` (${bits / 8} bytes)` : ""}</span>${field.variable ? " <em>(variable)</em>" : ""}</dd>
      ${categoryHtml}
      ${field.variable ? `<dt>Driven by</dt><dd><code>${escapeHtml(field.lengthFrom)}</code></dd>` : ""}
      ${field.controlsLength ? `<dt>Controls</dt><dd><code>${escapeHtml(field.controlsLength)}</code> (current: <span class="mono">${state.controllers[field.controlsLength]}</span>)</dd>` : ""}
      ${field.description ? `<dt>Description</dt><dd>${enrichDescription(field.description)}</dd>` : ""}
      ${subfieldsHtml}
    </dl>
  `;
}

// Format a field description for the detail panel:
//   1. Escape HTML.
//   2. Turn any "RFC NNNN" / "RFC NNNNN" reference into a clickable link
//      pointing at datatracker.ietf.org.
//   3. Wrap recognised acronyms in <dfn class="acronym"> tags so hover/focus
//      can reveal the glossary entry.
//
// Step ordering matters: we annotate acronyms AFTER inserting the RFC anchor
// so that the anchor's href is not mistaken for plain text containing "TLS",
// "DNS", etc.
function enrichDescription(text) {
  let escaped = escapeHtml(text);

  // RFC link substitution. The regex matches "RFC NNNN" or "RFCNNNN" with
  // 1-5 digits. The numeric capture group is what we put in the URL.
  // Replacement happens on the escaped string so surrounding context stays
  // safe.
  escaped = escaped.replace(/\b(RFC\s?(\d{1,5}))\b/g, (match, _full, num) => {
    return `<a class="rfc-link" href="https://datatracker.ietf.org/doc/html/rfc${num}" target="_blank" rel="noopener noreferrer">${match}</a>`;
  });

  // Glossary acronym annotation. annotateAcronyms operates on already-escaped
  // HTML and only matches whole-word acronyms, so it will not touch the RFC
  // anchor's attributes (those contain digits/slashes, not bare acronyms).
  escaped = annotateAcronyms(escaped);
  return escaped;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------------- Diagram keyboard navigation ----------------
//
// Field cells (top-level) implement a roving tabindex: only one cell is
// reachable via Tab at a time, and arrow keys move focus to neighboring cells
// (Left/Right within the row, Up/Down between rows). Subfield groups within
// the same parent likewise rove with Left/Right.

function initDiagramKeyboardNav() {
  els.diagram.addEventListener("focusin", onDiagramFocusIn);
  els.diagram.addEventListener("keydown", onDiagramKeydown);
}

function onDiagramFocusIn(e) {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (target.classList.contains("field-cell")) {
    setRovingTabindex(getFieldCells(), target);
  } else if (target.classList.contains("subfield-cell")) {
    const parentId = target.dataset.parentFieldId;
    setRovingTabindex(getSubfieldCells(parentId), target);
  }
}

function getFieldCells() {
  return Array.from(els.diagram.querySelectorAll("g.field-cell"));
}

function getSubfieldCells(parentId) {
  if (!parentId) return [];
  return Array.from(
    els.diagram.querySelectorAll(`g.subfield-cell[data-parent-field-id="${cssEscape(parentId)}"]`),
  );
}

function cssEscape(s) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_\-]/g, "\\$&");
}

function setRovingTabindex(group, focused) {
  for (const el of group) {
    el.setAttribute("tabindex", el === focused ? "0" : "-1");
  }
}

function onDiagramKeydown(e) {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (target.classList.contains("field-cell")) {
    handleFieldCellKey(e, target);
  } else if (target.classList.contains("subfield-cell")) {
    handleSubfieldCellKey(e, target);
  }
}

function handleFieldCellKey(e, current) {
  const cells = getFieldCells();
  if (cells.length === 0) return;
  const idx = cells.indexOf(current);
  if (idx === -1) return;
  let next = null;
  switch (e.key) {
    case "ArrowRight": next = cells[Math.min(cells.length - 1, idx + 1)]; break;
    case "ArrowLeft":  next = cells[Math.max(0, idx - 1)]; break;
    case "ArrowDown":  next = findRowNeighbor(cells, current, +1); break;
    case "ArrowUp":    next = findRowNeighbor(cells, current, -1); break;
    case "Home":       next = cells[0]; break;
    case "End":        next = cells[cells.length - 1]; break;
    default: return;
  }
  if (next && next !== current) {
    e.preventDefault();
    setRovingTabindex(cells, next);
    next.focus();
  }
}

function handleSubfieldCellKey(e, current) {
  const parentId = current.dataset.parentFieldId;
  const subs = getSubfieldCells(parentId);
  if (subs.length === 0) return;
  const idx = subs.indexOf(current);
  if (idx === -1) return;
  let next = null;
  switch (e.key) {
    case "ArrowRight": next = subs[Math.min(subs.length - 1, idx + 1)]; break;
    case "ArrowLeft":  next = subs[Math.max(0, idx - 1)]; break;
    case "Home":       next = subs[0]; break;
    case "End":        next = subs[subs.length - 1]; break;
    default: return;
  }
  if (next && next !== current) {
    e.preventDefault();
    setRovingTabindex(subs, next);
    next.focus();
  }
}

// Fallback row-neighbor finder: walks the cell list and picks the first cell
// whose row index differs by ±1 and whose horizontal range overlaps the
// current cell. Renderer encodes the row in `data-row`; if absent, fall back
// to direct list neighbors so navigation still works.
function findRowNeighbor(cells, current, direction) {
  const curRow = Number(current.dataset.row);
  if (Number.isNaN(curRow)) {
    const idx = cells.indexOf(current);
    return cells[Math.max(0, Math.min(cells.length - 1, idx + direction))];
  }
  const curStart = Number(current.dataset.startBit);
  const curEnd = Number(current.dataset.endBit);
  const targetRow = curRow + direction;
  // Prefer a cell on targetRow that overlaps current's bit range.
  const sameRow = cells.filter(c => Number(c.dataset.row) === targetRow);
  if (sameRow.length === 0) return null;
  const overlap = sameRow.find(c => {
    const s = Number(c.dataset.startBit);
    const en = Number(c.dataset.endBit);
    return !(en < curStart || s > curEnd);
  });
  return overlap || sameRow[0];
}

init();
