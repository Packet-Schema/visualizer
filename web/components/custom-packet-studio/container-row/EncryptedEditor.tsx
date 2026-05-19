import type { Container, Encrypted } from "@/lib/psml/types";

import ExprBuilder from "../ExprBuilder";

import { Frame, inputStyle, type Patch } from "./shared";

export function EncryptedEditor({
  container,
  patch,
  siblingFieldIds,
}: {
  container: Encrypted;
  patch: Patch;
  siblingFieldIds: string[];
}) {
  const plaintextIds = container.plaintext.fields
    .filter((f): f is Container & { id: string } => "id" in f)
    .map((f) => f.id);
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
