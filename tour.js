// Lightweight onboarding tour.
//
// `startTour({ steps, onComplete })` builds an overlay with a "spotlight"
// cutout over the requested target element and a tooltip with Next / Skip
// buttons. The tour is bare-bones on purpose — no external library, no
// build step.
//
// Each step is { target?: () => Element | null, title, body, placement? }.
// `target` is a function so we evaluate it lazily (the bit ruler / slider
// may not exist until a packet is rendered). Steps without a target render
// as a centered welcome card.
//
// localStorage flag "packet-view-tour-seen" persists across sessions so the
// tour only auto-launches once. The toolbar "?" button re-launches anytime.

const SEEN_KEY = "packet-view-tour-seen";

export function hasSeenTour() {
  try { return localStorage.getItem(SEEN_KEY) === "1"; }
  catch (_) { return false; }
}

export function markTourSeen() {
  try { localStorage.setItem(SEEN_KEY, "1"); } catch (_) { /* ignore */ }
}

// Public entry point.
export function startTour({ steps, onComplete } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) return;
  if (document.querySelector(".tour-overlay")) return; // already running

  let idx = 0;
  let priorActive = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  const overlay = document.createElement("div");
  overlay.className = "tour-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Onboarding tour");

  const spotlight = document.createElement("div");
  spotlight.className = "tour-spotlight";
  spotlight.setAttribute("aria-hidden", "true");

  const tooltip = document.createElement("div");
  tooltip.className = "tour-tooltip";
  tooltip.setAttribute("role", "document");

  const title = document.createElement("h3");
  title.className = "tour-title";

  const body = document.createElement("p");
  body.className = "tour-body";

  const progress = document.createElement("div");
  progress.className = "tour-progress";

  const actions = document.createElement("div");
  actions.className = "tour-actions";

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "tour-btn tour-btn-skip";
  skipBtn.textContent = "Skip";

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "tour-btn tour-btn-next";

  actions.appendChild(skipBtn);
  actions.appendChild(nextBtn);

  tooltip.appendChild(title);
  tooltip.appendChild(body);
  tooltip.appendChild(progress);
  tooltip.appendChild(actions);

  overlay.appendChild(spotlight);
  overlay.appendChild(tooltip);
  document.body.appendChild(overlay);

  function finish(completed) {
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", refresh);
    window.removeEventListener("scroll", refresh, true);
    overlay.remove();
    markTourSeen();
    if (priorActive && document.contains(priorActive)) {
      try { priorActive.focus(); } catch (_) { /* ignore */ }
    }
    if (typeof onComplete === "function") onComplete({ completed });
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      advance();
    }
  }

  function advance() {
    if (idx >= steps.length - 1) {
      finish(true);
    } else {
      idx++;
      refresh();
    }
  }

  function refresh() {
    const step = steps[idx];
    if (!step) return;

    title.textContent = step.title || "";
    body.textContent = step.body || "";
    progress.textContent = `Step ${idx + 1} of ${steps.length}`;
    nextBtn.textContent = idx === steps.length - 1 ? "Done" : "Next";

    const target = typeof step.target === "function" ? step.target() : null;
    positionFor(target, step.placement);
  }

  function positionFor(target, placement) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let rect = null;
    if (target && typeof target.getBoundingClientRect === "function") {
      try { target.scrollIntoView({ block: "center", behavior: "auto" }); }
      catch (_) { /* ignore */ }
      rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) rect = null;
    }

    if (rect) {
      const pad = 8;
      const sx = Math.max(4, rect.left - pad);
      const sy = Math.max(4, rect.top - pad);
      const sw = Math.min(vw - sx - 4, rect.width + pad * 2);
      const sh = Math.min(vh - sy - 4, rect.height + pad * 2);
      spotlight.style.display = "block";
      spotlight.style.left = sx + "px";
      spotlight.style.top = sy + "px";
      spotlight.style.width = sw + "px";
      spotlight.style.height = sh + "px";

      // Pick placement: prefer the side with most room.
      const place = placement || (vh - rect.bottom > rect.top ? "bottom" : "top");
      const ttW = Math.min(360, vw - 32);
      tooltip.style.width = ttW + "px";
      // Force a reflow read for height after content set.
      const ttH = tooltip.offsetHeight || 160;
      let left = Math.min(vw - ttW - 12, Math.max(12, rect.left + rect.width / 2 - ttW / 2));
      let top;
      if (place === "top") {
        top = Math.max(12, sy - ttH - 12);
      } else {
        top = Math.min(vh - ttH - 12, sy + sh + 12);
      }
      tooltip.style.left = left + "px";
      tooltip.style.top = top + "px";
      tooltip.classList.remove("tour-tooltip-center");
    } else {
      // No target — center the tooltip and hide the spotlight.
      spotlight.style.display = "none";
      tooltip.style.width = Math.min(420, vw - 32) + "px";
      tooltip.classList.add("tour-tooltip-center");
      tooltip.style.left = "";
      tooltip.style.top = "";
    }
  }

  nextBtn.addEventListener("click", advance);
  skipBtn.addEventListener("click", () => finish(false));
  // Click on the dim backdrop (but not on the tooltip/spotlight) closes.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) finish(false);
  });
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", refresh);
  window.addEventListener("scroll", refresh, true);

  refresh();
  // Move keyboard focus into the tour so Tab/Enter work as expected.
  setTimeout(() => { try { nextBtn.focus(); } catch (_) {} }, 0);
}
