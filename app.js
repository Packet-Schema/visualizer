import {
  PACKETS, resolvePacket, initialState,
  CATEGORY_LABELS, DEFAULT_BYTE_ORDER, packetCategories,
  syncTlvControllers,
} from "./packets.js";
import { renderPacket, interactiveUpdate, CATEGORY_TO_TOKEN, tokenToCssVar } from "./renderer.js";
import { annotateAcronyms } from "./glossary.js";
import { toJson, fromJson } from "./formats/json.js";
import { toAscii } from "./formats/rfc-ascii.js";
import { fromAad } from "./formats/aug-ascii.js";
import { toWorksheet } from "./formats/worksheet.js";
import { startTour, hasSeenTour } from "./tour.js";

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
  btnHelp: document.getElementById("btn-help"),
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
  fieldPopover: document.getElementById("field-popover"),
};

// Popover/field-detail layout threshold. Above this width, clicks on a field
// open an anchored popover (in addition to the right-side panel).
const POPOVER_MIN_WIDTH = 900;

// Tracks the SVG element currently rendered in the diagram so the slider
// interactive-update path can mutate it without a full rebuild.
let currentSvg = null;
// When true, the next call to render() will animate cell width/x changes
// rather than rebuild the SVG.
let interactiveRenderPending = false;

// Curriculum-ordered grouping of built-in presets by OSI layer.
// Keys must match PACKETS keys in packets.js.
const PRESET_GROUPS = [
  { label: "Layer 2 — Link",        keys: ["ethernet", "vlan"] },
  { label: "Layer 3 — Network",     keys: ["ipv4", "ipv6", "arp", "icmp", "icmpv6"] },
  { label: "Layer 4 — Transport",   keys: ["tcp", "udp"] },
  { label: "Application",           keys: ["dns", "tlsRecord", "tlsClientHello", "quicShort"] },
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
  initFieldPopover();
  render();
  initDiagramKeyboardNav();
  initHelpButton();
  // First-visit tour auto-launch. Delay slightly so the diagram has rendered
  // and target elements can be located.
  if (!hasSeenTour()) {
    setTimeout(launchTour, 350);
  }
}

function launchTour() {
  startTour({
    steps: [
      {
        title: "Welcome to Packet View",
        body: "Packet View teaches network protocols visually. Pick a packet, click any field, and tweak sliders to see how the bytes line up.",
      },
      {
        title: "The bit ruler",
        body: "Each row is 32 bits wide. The numbers across the top mark bit positions — useful for matching up with RFC diagrams.",
        target: () => els.diagram.querySelector(".bit-ruler"),
        placement: "bottom",
      },
      {
        title: "Click any field",
        body: "Cells are interactive. Click one for a popover with size, category, RFC links and a glossary tooltip.",
        target: () => els.diagram.querySelector("g.field-cell"),
        placement: "bottom",
      },
      {
        title: "Drag to grow",
        body: "Variable-length fields like IPv4 Options have a slider. Drag it to see the Options grow and the header reflow.",
        target: () => els.controls.querySelector('input[type="range"]'),
        placement: "top",
      },
    ],
  });
}

function initHelpButton() {
  if (!els.btnHelp) return;
  els.btnHelp.addEventListener("click", () => {
    closeFieldPopover();
    launchTour();
  });
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

  // Diagram: prefer in-place interactive update when the slider just changed
  // a controlling value and the structural shape is unchanged. Falls back to
  // full rebuild otherwise.
  let usedInteractive = false;
  if (interactiveRenderPending && currentSvg && els.diagram.contains(currentSvg)) {
    usedInteractive = interactiveUpdate(currentSvg, packet, layout);
  }
  interactiveRenderPending = false;
  if (!usedInteractive) {
    els.diagram.innerHTML = "";
    currentSvg = renderPacket(packet, layout, {
      selectedFieldId: state.selectedFieldId,
      onFieldClick: (field, event) => {
        state.selectedFieldId = field.id;
        render();
        maybeOpenPopover(field, event);
      },
      onSubfieldClick: (parentField, subfield, event) => {
        state.selectedFieldId = `${parentField.id}:${subfield.id}`;
        render();
        // Subfield popovers reuse the same anchor logic.
        maybeOpenPopover(subfield, event, parentField);
      },
    });
    els.diagram.appendChild(currentSvg);
  }

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
  // A controller is "locked" by a TLV when any field has a tlv.drivesController
  // matching this controller key AND has at least one active instance.
  const tlvLocked = new Set();
  for (const f of packet.fields) {
    if (f.tlv && f.tlv.drivesController && (f.tlv.instances || []).length > 0) {
      tlvLocked.add(f.tlv.drivesController);
    }
  }
  for (const field of controllers) {
    const value = state.controllers[field.controlsLength];
    const baseId = `ctrl-${field.id}`;
    const sliderId = `${baseId}-slider`;
    const numberId = `${baseId}-number`;
    const labelId = `${baseId}-label`;
    const hintId = `${baseId}-hint`;
    const locked = tlvLocked.has(field.controlsLength);

    const wrap = document.createElement("div");
    wrap.className = "control";
    if (locked) wrap.classList.add("control-locked");

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
    if (locked) slider.disabled = true;
    if (field.description) slider.setAttribute("aria-describedby", hintId);

    const number = document.createElement("input");
    number.type = "number";
    number.id = numberId;
    number.min = slider.min;
    number.max = slider.max;
    number.value = value;
    number.className = "control-number";
    if (locked) number.disabled = true;
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

    const apply = (v, interactive) => {
      const clamped = Math.max(Number(slider.min), Math.min(Number(slider.max), Number(v)));
      state.controllers[field.controlsLength] = clamped;
      slider.value = clamped;
      number.value = clamped;
      updateValueText(clamped);
      // Slider drags want a smooth, animated update; number-input commits do
      // a full rebuild so any structural change is reflected correctly.
      interactiveRenderPending = !!interactive;
      render();
    };
    slider.addEventListener("input", e => apply(e.target.value, true));
    number.addEventListener("change", e => apply(e.target.value, false));

    row.appendChild(slider);
    row.appendChild(number);
    wrap.appendChild(row);
    if (locked) {
      const note = document.createElement("p");
      note.className = "control-locked-note";
      note.textContent = "Controlled by attached TLV options — edit the Options field instead.";
      wrap.appendChild(note);
    }
    els.controls.appendChild(wrap);
  }
}

// ---------------- Field detail popover ----------------
//
// On wide viewports (>= POPOVER_MIN_WIDTH px) clicking a field opens a
// popover anchored above or below the clicked cell (whichever fits), in
// addition to populating the right-side detail panel. On narrow viewports
// we keep the panel-only behavior so the popover never crowds the diagram.

let popoverReturnFocusEl = null;

function initFieldPopover() {
  if (!els.fieldPopover) return;
  const closeBtn = els.fieldPopover.querySelector(".field-popover-close");
  if (closeBtn) closeBtn.addEventListener("click", closeFieldPopover);
  // Click-outside dismissal: any click outside the popover and not inside the
  // diagram (where a field-cell click will reopen with new content) closes
  // the popover. We attach in bubble phase so the cell's click handler has
  // already run and replaced the popover content first.
  document.addEventListener("click", (e) => {
    if (els.fieldPopover.hidden) return;
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (els.fieldPopover.contains(t)) return;
    if (els.diagram && els.diagram.contains(t)) return;
    closeFieldPopover();
  });
  document.addEventListener("keydown", (e) => {
    if (!els.fieldPopover.hidden && e.key === "Escape") {
      e.preventDefault();
      closeFieldPopover();
    }
  });
  window.addEventListener("resize", () => {
    if (!els.fieldPopover.hidden) closeFieldPopover();
  });
}

function maybeOpenPopover(field, event, parentField) {
  if (!els.fieldPopover) return;
  if (window.innerWidth < POPOVER_MIN_WIDTH) return;
  // Anchor element: the original click target may have been detached by the
  // re-render that ran before this function. Re-query the freshly rebuilt
  // diagram by fieldId so we always anchor against a live node.
  let anchor = null;
  const targetFieldId = parentField ? field.id : field.id;
  if (parentField) {
    anchor = els.diagram.querySelector(
      `g.subfield-cell[data-subfield-id="${cssEscape(targetFieldId)}"][data-parent-field-id="${cssEscape(parentField.id)}"]`,
    );
  } else {
    anchor = els.diagram.querySelector(
      `g.field-cell[data-field-id="${cssEscape(targetFieldId)}"]`,
    );
  }
  // Fallback to the original event target if the rebuild somehow lost it.
  if (!anchor && event && event.currentTarget instanceof Element
      && document.contains(event.currentTarget)) {
    anchor = event.currentTarget;
  }
  // Build content from the same enrichment used by the panel.
  const packet = getPacket(state.packetKey);
  const html = buildFieldDetailHtml(packet, field, parentField);
  if (!html) return;
  const body = els.fieldPopover.querySelector(".field-popover-body");
  if (body) body.innerHTML = html;

  // Remember opener so we can return focus on close.
  popoverReturnFocusEl = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  els.fieldPopover.hidden = false;
  positionPopover(anchor);
}

function positionPopover(anchor) {
  if (!els.fieldPopover || !anchor) {
    els.fieldPopover.style.left = "20px";
    els.fieldPopover.style.top = "80px";
    return;
  }
  const rect = anchor.getBoundingClientRect();
  // Measure popover size (after content is set).
  const ttRect = els.fieldPopover.getBoundingClientRect();
  const ttW = ttRect.width;
  const ttH = ttRect.height;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;
  const spaceBelow = vh - rect.bottom;
  const spaceAbove = rect.top;
  // Place below if the popover fits below; otherwise above.
  const placeBelow = spaceBelow >= ttH + margin + 10
    || spaceBelow >= spaceAbove;
  const cellCenterX = rect.left + rect.width / 2;
  let left = Math.round(cellCenterX - ttW / 2);
  left = Math.max(8, Math.min(vw - ttW - 8, left));
  let top;
  if (placeBelow) {
    top = Math.round(rect.bottom + margin);
    els.fieldPopover.dataset.placement = "below";
  } else {
    top = Math.round(rect.top - ttH - margin);
    els.fieldPopover.dataset.placement = "above";
  }
  els.fieldPopover.style.left = left + "px";
  els.fieldPopover.style.top = top + "px";
  // Position the arrow relative to popover so it points at the cell.
  const arrow = els.fieldPopover.querySelector(".field-popover-arrow");
  if (arrow) {
    const arrowX = Math.max(12, Math.min(ttW - 24, cellCenterX - left - 6));
    arrow.style.left = arrowX + "px";
  }
}

function closeFieldPopover() {
  if (!els.fieldPopover || els.fieldPopover.hidden) return;
  els.fieldPopover.hidden = true;
  if (popoverReturnFocusEl && document.contains(popoverReturnFocusEl)) {
    try { popoverReturnFocusEl.focus(); } catch (_) {}
  }
  popoverReturnFocusEl = null;
}

// Build the same content `renderDetail` produces, but without writing to
// the detail panel. Returns an HTML string.
function buildFieldDetailHtml(packet, fieldOrSub, parentField) {
  // Subfield branch: `parentField` is provided.
  if (parentField) {
    const sub = fieldOrSub;
    const bits = sub.bits;
    return `
      <h3>${escapeHtml(sub.name)} <span class="subfield-hint">(subfield of ${escapeHtml(parentField.name)})</span></h3>
      <dl>
        <dt>Size</dt><dd>${bits} bit${bits === 1 ? "" : "s"}</dd>
        <dt>Parent</dt><dd>${escapeHtml(parentField.name)} (${parentField.bits} bits)</dd>
        ${sub.description ? `<dt>Description</dt><dd>${enrichDescription(sub.description)}</dd>` : ""}
      </dl>
    `;
  }
  const field = fieldOrSub;
  const bits = field.variable
    ? field.toBits(state.controllers[field.lengthFrom])
    : field.bits;
  const subfieldsHtml = field.subfields
    ? `<dt>Subfields</dt><dd>${field.subfields.map(s => `<code>${escapeHtml(s.name)}</code> (${s.bits}b)`).join(" ")}</dd>`
    : "";
  const categoryHtml = field.category
    ? `<dt>Category</dt><dd>${escapeHtml(CATEGORY_LABELS[field.category] || field.category)}</dd>`
    : "";
  return `
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
  els.modalFormat.value = "json";
  els.modalText.value = "";
  setStatus("");
  els.modalOverlay.hidden = false;
  // syncModalUi handles auto-fill on export and clears text on import.
  syncModalUi();

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
  els.modalApply.hidden    = !importMode;
  // Generate button is only needed for worksheet (which opens a new tab); for
  // other export formats we auto-fill on selection.
  els.modalGenerate.hidden = !(isWorksheet);
  // The Copy button is meaningless for worksheet (we open a new tab instead).
  els.modalCopy.hidden     = importMode || isWorksheet;
  if (els.modalWorksheetLabel) {
    els.modalWorksheetLabel.hidden = !isWorksheet;
  }
  if (isWorksheet) {
    els.modalText.placeholder = "Click Generate to open the worksheet in a new tab.";
    els.modalText.value = "";
  } else if (importMode) {
    els.modalText.placeholder = "Paste packet definition here, then click Apply.";
    els.modalText.value = "";
  } else {
    // Export, non-worksheet: auto-fill the textarea immediately.
    els.modalText.placeholder = "";
    onGenerate();
  }
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

  // A click on a TLV-expanded virtual cell produces id like "options#0" — route
  // that back to its parent options field so the editor is shown.
  if (state.selectedFieldId.includes("#")) {
    const [parentId, rest] = state.selectedFieldId.split("#");
    const parent = packet.fields.find(f => f.id === parentId);
    if (parent && parent.tlv) {
      const blockIdx = Number(rest);
      renderTlvDetail(packet, parent, { focusBlockIndex: blockIdx });
      return;
    }
    if (parent && parent.chainCatalog) {
      // Click on a chain extension header.
      const blockIdx = Number((rest || "").split("#").pop());
      renderChainDetail(packet, parent, { focusBlockIndex: blockIdx });
      return;
    }
    // A virtual chain block id is "<fieldId>@chain#<idx>".
    if (parentId.endsWith("@chain")) {
      const realParentId = parentId.slice(0, -"@chain".length);
      const realParent = packet.fields.find(f => f.id === realParentId);
      if (realParent && realParent.chainCatalog) {
        renderChainDetail(packet, realParent, { focusBlockIndex: Number(rest) });
        return;
      }
    }
  }

  // Subfield selection has the form "parentId:subfieldId".
  if (state.selectedFieldId.includes(":")) {
    const [parentId, subId] = state.selectedFieldId.split(":");
    // Subfield could belong to a TLV virtual cell whose id is "<owner>#<n>".
    let parent = packet.fields.find(f => f.id === parentId);
    let sub = parent && parent.subfields
      ? parent.subfields.find(s => s.id === subId)
      : null;
    if (!parent && parentId.includes("#")) {
      // Synthesise from the resolved layout.
      const synth = findVirtualField(packet, parentId);
      if (synth) {
        parent = synth;
        sub = synth.subfields.find((s) => s.id === subId) || null;
      }
    }
    if (!parent || !sub) {
      els.detail.innerHTML = `<p class="muted">Subfield not found.</p>`;
      return;
    }
    const bits = sub.bits;
    els.detail.innerHTML = `
      <h3>${escapeHtml(sub.name)} <span class="subfield-hint">(subfield of ${escapeHtml(parent.name)})</span></h3>
      <dl>
        <dt>Size</dt><dd>${bits} bit${bits === 1 ? "" : "s"}</dd>
        <dt>Parent</dt><dd>${escapeHtml(parent.name)}</dd>
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
  // TLV-bearing field: show the option list editor.
  if (field.tlv) {
    renderTlvDetail(packet, field, {});
    return;
  }
  // Chain-bearing field (e.g. IPv6 Next Header): show extension header editor.
  if (field.chainCatalog) {
    renderChainDetail(packet, field, {});
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

// Reconstruct a virtual TLV field descriptor by re-resolving the layout and
// matching by id. Used when a subfield click lands on a TLV-expanded cell.
function findVirtualField(packet, virtualId) {
  const layout = resolvePacket(packet, state.controllers);
  for (const cell of layout.cells) {
    if (cell.field && cell.field.id === virtualId) return cell.field;
  }
  return null;
}

function renderTlvDetail(packet, field, opts) {
  const tlv = field.tlv;
  const instances = tlv.instances || [];
  // Pretty-print the current option list with Remove buttons.
  let html = `<h3>${escapeHtml(field.name)}</h3>`;
  html += `<p class="muted small">Recursive TLV container. Add typed records below; the total length drives <code>${escapeHtml(tlv.drivesController || "")}</code>.</p>`;
  if (field.description) {
    html += `<p class="control-hint">${enrichDescription(field.description)}</p>`;
  }
  html += `<div class="tlv-list" role="list">`;
  if (instances.length === 0) {
    html += `<p class="muted small">No options attached yet.</p>`;
  } else {
    instances.forEach((inst, i) => {
      const entry = tlv.catalog.find((c) => c.kind === inst.kind);
      if (!entry) return;
      const extras = { ...(entry.defaultExtras || {}), ...(inst.extras || {}) };
      const blockFields = typeof entry.fieldsFor === "function"
        ? entry.fieldsFor(extras)
        : entry.fields;
      const bits = (blockFields || []).reduce((a, f) => a + f.bits, 0);
      const focused = opts.focusBlockIndex === i ? " tlv-row-focused" : "";
      html += `<div class="tlv-row${focused}" role="listitem">`;
      html += `<div class="tlv-row-head">`;
      html += `<span class="tlv-kind-badge">kind ${entry.kind}</span> `;
      html += `<span class="tlv-row-name">${escapeHtml(entry.name)}</span> `;
      html += `<span class="tlv-row-bits mono">${bits} b / ${bits / 8} B</span> `;
      html += `<button type="button" class="tlv-up" data-idx="${i}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>`;
      html += `<button type="button" class="tlv-down" data-idx="${i}" aria-label="Move down" ${i === instances.length - 1 ? "disabled" : ""}>↓</button>`;
      html += `<button type="button" class="tlv-remove" data-idx="${i}">Remove</button>`;
      html += `</div>`;
      if (entry.variableCount) {
        const vc = entry.variableCount;
        const cur = Number(extras[vc.key] ?? vc.min ?? 1);
        html += `<div class="tlv-row-extras"><label>${escapeHtml(vc.label || vc.key)}: `;
        html += `<input type="number" class="tlv-extra-count" data-idx="${i}" data-key="${escapeHtml(vc.key)}" `;
        html += `min="${vc.min ?? 1}" max="${vc.max ?? 16}" value="${cur}"></label></div>`;
      }
      if (entry.description) {
        html += `<p class="tlv-row-desc">${enrichDescription(entry.description)}</p>`;
      }
      html += `</div>`;
    });
  }
  html += `</div>`;
  html += `<div class="tlv-add-row">`;
  html += `<label>Add option: <select class="tlv-add-select">`;
  html += `<option value="">-- choose a record type --</option>`;
  for (const c of tlv.catalog) {
    html += `<option value="${c.kind}">${escapeHtml(c.name)} (kind ${c.kind})</option>`;
  }
  html += `</select></label>`;
  html += `<button type="button" class="tlv-add-btn">Add</button>`;
  html += `</div>`;
  const totalBits = instances.reduce((acc, inst) => {
    const entry = tlv.catalog.find((c) => c.kind === inst.kind);
    if (!entry) return acc;
    const extras = { ...(entry.defaultExtras || {}), ...(inst.extras || {}) };
    const fs = typeof entry.fieldsFor === "function" ? entry.fieldsFor(extras) : entry.fields;
    return acc + (fs || []).reduce((a, f) => a + f.bits, 0);
  }, 0);
  const padded = tlv.padToBoundary
    ? Math.ceil(totalBits / tlv.padToBoundary) * tlv.padToBoundary
    : totalBits;
  html += `<p class="tlv-summary muted small">`;
  html += `Total: <span class="mono">${totalBits} b</span>; padded to <span class="mono">${padded} b</span> (= ${padded / 8} B).`;
  if (tlv.drivesController) {
    html += ` Drives <code>${escapeHtml(tlv.drivesController)}</code> = <span class="mono">${state.controllers[tlv.drivesController]}</span>.`;
  }
  html += `</p>`;

  els.detail.innerHTML = html;

  // Wire up controls.
  els.detail.querySelectorAll(".tlv-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      field.tlv.instances.splice(idx, 1);
      syncTlvControllers(packet, state.controllers);
      state.selectedFieldId = field.id;
      render();
    });
  });
  els.detail.querySelectorAll(".tlv-up").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      if (idx > 0) {
        const t = field.tlv.instances[idx - 1];
        field.tlv.instances[idx - 1] = field.tlv.instances[idx];
        field.tlv.instances[idx] = t;
        syncTlvControllers(packet, state.controllers);
        state.selectedFieldId = field.id;
        render();
      }
    });
  });
  els.detail.querySelectorAll(".tlv-down").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      if (idx < field.tlv.instances.length - 1) {
        const t = field.tlv.instances[idx + 1];
        field.tlv.instances[idx + 1] = field.tlv.instances[idx];
        field.tlv.instances[idx] = t;
        syncTlvControllers(packet, state.controllers);
        state.selectedFieldId = field.id;
        render();
      }
    });
  });
  els.detail.querySelectorAll(".tlv-extra-count").forEach((inp) => {
    inp.addEventListener("change", () => {
      const idx = Number(inp.dataset.idx);
      const key = inp.dataset.key;
      const inst = field.tlv.instances[idx];
      if (!inst) return;
      const v = Math.max(Number(inp.min) || 1, Math.min(Number(inp.max) || 16, Number(inp.value) || 1));
      inst.extras = { ...(inst.extras || {}), [key]: v };
      syncTlvControllers(packet, state.controllers);
      state.selectedFieldId = field.id;
      render();
    });
  });
  const addBtn = els.detail.querySelector(".tlv-add-btn");
  const addSel = els.detail.querySelector(".tlv-add-select");
  if (addBtn && addSel) {
    addBtn.addEventListener("click", () => {
      const kind = Number(addSel.value);
      if (!Number.isFinite(kind)) return;
      const entry = field.tlv.catalog.find((c) => c.kind === kind);
      if (!entry) return;
      const inst = { kind };
      if (entry.defaultExtras) inst.extras = { ...entry.defaultExtras };
      field.tlv.instances.push(inst);
      syncTlvControllers(packet, state.controllers);
      state.selectedFieldId = field.id;
      render();
    });
  }
}

function renderChainDetail(packet, field, opts) {
  const instances = field.chainInstances || (field.chainInstances = []);
  let html = `<h3>${escapeHtml(field.name)} — chain</h3>`;
  html += `<p class="muted small">Attach IPv6 extension headers in order. The final Next Header is the upper-layer protocol.</p>`;
  if (field.description) {
    html += `<p class="control-hint">${enrichDescription(field.description)}</p>`;
  }
  html += `<div class="tlv-list">`;
  if (instances.length === 0) {
    html += `<p class="muted small">No extension headers attached.</p>`;
  } else {
    instances.forEach((inst, i) => {
      const entry = field.chainCatalog.find((c) => c.proto === inst.proto);
      if (!entry) return;
      const bits = entry.fields.reduce((a, f) => a + f.bits, 0);
      const focused = opts.focusBlockIndex === i ? " tlv-row-focused" : "";
      html += `<div class="tlv-row${focused}">`;
      html += `<div class="tlv-row-head">`;
      html += `<span class="tlv-kind-badge">proto ${entry.proto}</span> `;
      html += `<span class="tlv-row-name">${escapeHtml(entry.name)}</span> `;
      html += `<span class="tlv-row-bits mono">${bits} b / ${bits / 8} B</span> `;
      html += `<button type="button" class="chain-up" data-idx="${i}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>`;
      html += `<button type="button" class="chain-down" data-idx="${i}" aria-label="Move down" ${i === instances.length - 1 ? "disabled" : ""}>↓</button>`;
      html += `<button type="button" class="chain-remove" data-idx="${i}">Remove</button>`;
      html += `</div>`;
      if (entry.description) {
        html += `<p class="tlv-row-desc">${enrichDescription(entry.description)}</p>`;
      }
      html += `</div>`;
    });
  }
  html += `</div>`;
  html += `<div class="tlv-add-row">`;
  html += `<label>Add extension header: <select class="chain-add-select">`;
  html += `<option value="">-- choose an extension header --</option>`;
  for (const c of field.chainCatalog) {
    html += `<option value="${c.proto}">${escapeHtml(c.name)} (proto ${c.proto})</option>`;
  }
  html += `</select></label>`;
  html += `<button type="button" class="chain-add-btn">Add</button>`;
  html += `</div>`;
  html += `<div class="tlv-add-row">`;
  html += `<label>Final upper-layer protocol: <select class="chain-final-select">`;
  const finals = [
    { v: 6, name: "TCP" }, { v: 17, name: "UDP" }, { v: 58, name: "ICMPv6" },
    { v: 50, name: "ESP" }, { v: 132, name: "SCTP" }, { v: 59, name: "No Next Header" },
  ];
  for (const f of finals) {
    const sel = field.chainFinalProto === f.v ? " selected" : "";
    html += `<option value="${f.v}"${sel}>${f.name} (${f.v})</option>`;
  }
  html += `</select></label></div>`;

  els.detail.innerHTML = html;

  els.detail.querySelectorAll(".chain-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      field.chainInstances.splice(idx, 1);
      state.selectedFieldId = field.id;
      render();
    });
  });
  els.detail.querySelectorAll(".chain-up").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      if (idx > 0) {
        const t = field.chainInstances[idx - 1];
        field.chainInstances[idx - 1] = field.chainInstances[idx];
        field.chainInstances[idx] = t;
        state.selectedFieldId = field.id;
        render();
      }
    });
  });
  els.detail.querySelectorAll(".chain-down").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      if (idx < field.chainInstances.length - 1) {
        const t = field.chainInstances[idx + 1];
        field.chainInstances[idx + 1] = field.chainInstances[idx];
        field.chainInstances[idx] = t;
        state.selectedFieldId = field.id;
        render();
      }
    });
  });
  const addBtn = els.detail.querySelector(".chain-add-btn");
  const addSel = els.detail.querySelector(".chain-add-select");
  if (addBtn && addSel) {
    addBtn.addEventListener("click", () => {
      const proto = Number(addSel.value);
      if (!Number.isFinite(proto)) return;
      field.chainInstances.push({ proto });
      state.selectedFieldId = field.id;
      render();
    });
  }
  const finalSel = els.detail.querySelector(".chain-final-select");
  if (finalSel) {
    finalSel.addEventListener("change", () => {
      field.chainFinalProto = Number(finalSel.value);
      state.selectedFieldId = field.id;
      render();
    });
  }
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
