import type { Container, Encrypted } from "@/lib/psdl/types";
import { isField } from "@/lib/psdl/utils";

import ExprBuilder from "../ExprBuilder";

import { Frame, inputStyle, type Patch } from "./shared";

/**
 * Walk the plaintext body recursively and return every reachable leaf
 * Field id. `validatePsdlPacket` resolves `headerProtected` entries
 * against this same set (leaves under Group / Repeat / Switch /
 * Optional are all valid targets), so the UI must mirror it — picking
 * a Group / Repeat id from the surface level would fail validation, and
 * conversely a leaf nested inside a Group used to be unreachable from
 * this checkbox list (Copilot review).
 */
function collectLeafFieldIds(containers: Container[]): string[] {
  // De-dup via Set: a Switch fan-out can declare the same leaf id
  // (`type`, `length`, …) in multiple case arms, and we'd otherwise
  // render the checkbox twice. `validatePsdlPacket` resolves against a
  // Set, so the editor mirrors that semantics — the first occurrence
  // dictates checkbox order to keep the layout stable across renders
  // (Copilot review).
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (cs: Container[]): void => {
    for (const c of cs) {
      if (isField(c)) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          out.push(c.id);
        }
        continue;
      }
      switch (c.kind) {
        case "group":
          walk(c.children);
          break;
        case "repeat":
          walk(c.element.fields);
          break;
        case "switch":
          for (const branch of Object.values(c.cases)) walk(branch.fields);
          break;
        case "optional":
          walk([c.container]);
          break;
        case "encrypted":
          // Encrypted-in-encrypted: keep the recursive ids reachable for
          // completeness, even though that nesting is unusual.
          walk(c.plaintext.fields);
          break;
      }
    }
  };
  walk(containers);
  return out;
}

export function EncryptedEditor({
  container,
  patch,
  siblingFieldIds,
}: {
  container: Encrypted;
  patch: Patch;
  siblingFieldIds: string[];
}) {
  const plaintextIds = collectLeafFieldIds(container.plaintext.fields);
  const protectedSet = new Set(container.headerProtected ?? []);

  const toggleProtected = (id: string) => {
    const next = new Set(protectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    patch({ headerProtected: Array.from(next) });
  };

  return (
    <Frame kind="encrypted">
      <input
        type="text"
        value={container.name ?? ""}
        aria-label="Encrypted name"
        placeholder="name"
        onChange={(e) => patch({ name: e.target.value })}
        className="text-sm px-2 py-1 rounded border w-60"
        style={inputStyle()}
      />
      <label className="text-xs text-fg-muted">wireBits</label>
      <ExprBuilder
        value={container.wireBits ?? { kind: "lit", value: 0 }}
        fieldIds={siblingFieldIds}
        onChange={(e) => patch({ wireBits: e })}
      />
      <label className="text-xs text-fg-muted">contextNote</label>
      <textarea
        value={container.contextNote}
        aria-label="Context note"
        rows={2}
        onChange={(e) => patch({ contextNote: e.target.value })}
        className="text-sm px-2 py-1 rounded border"
        style={inputStyle()}
      />
      <label className="text-xs text-fg-muted">headerProtected</label>
      <div className="flex flex-wrap gap-2">
        {plaintextIds.length === 0 && (
          <span className="text-xs text-fg-faint">(no plaintext fields)</span>
        )}
        {plaintextIds.map((id) => (
          <label
            key={id}
            className="text-sm flex items-center gap-1 px-2 py-1 rounded border"
            style={inputStyle()}
          >
            <input
              type="checkbox"
              checked={protectedSet.has(id)}
              onChange={() => toggleProtected(id)}
              aria-label={`Header-protect ${id}`}
            />
            {id}
          </label>
        ))}
      </div>
    </Frame>
  );
}
