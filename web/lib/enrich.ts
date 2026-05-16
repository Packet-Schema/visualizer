// Description enrichment for the detail panel and field popover.
//
// Pipeline:
//   1. HTML-escape the raw description so any incidental angle-brackets or
//      ampersands cannot break out into markup.
//   2. Replace `RFC NNNN` / `RFCNNNN` references with a clickable anchor to
//      datatracker.ietf.org. Replacement runs on the escaped string so the
//      anchor's attributes are quoted safely.
//   3. Annotate known acronyms via `annotateAcronyms` (operates on escaped
//      HTML and won't touch the RFC anchor attributes — those contain digits
//      and slashes, not bare acronyms).
//
// Source description text comes from the curated preset data files, so the
// HTML it produces is trusted enough to use `dangerouslySetInnerHTML`.

import { annotateAcronyms } from "./glossary";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

const RFC_PATTERN = /\b(RFC\s?(\d{1,5}))\b/g;

/** Produce an HTML string with RFC links + acronym `<dfn>` annotations. */
export function enrichDescriptionHtml(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(RFC_PATTERN, (match, _full: string, num: string) => {
    return `<a class="rfc-link" href="https://datatracker.ietf.org/doc/html/rfc${num}" target="_blank" rel="noopener noreferrer">${match}</a>`;
  });
  html = annotateAcronyms(html);
  return html;
}
