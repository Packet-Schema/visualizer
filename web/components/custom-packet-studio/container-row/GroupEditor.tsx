import type { Group } from "@/lib/psml/types";

import { Frame, inputStyle, type Patch } from "./shared";

export function GroupEditor({
  container,
  patch,
}: {
  container: Group;
  patch: Patch;
}) {
  return (
    <Frame kind="group">
      <input
        type="text"
        value={container.name ?? ""}
        aria-label="Group name"
        placeholder="name"
        onChange={(e) => patch({ name: e.target.value })}
        className="text-sm px-2 py-1 rounded border w-60"
        style={inputStyle()}
      />
    </Frame>
  );
}
