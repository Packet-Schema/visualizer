// Dispatch shell for the container editors. Each container variant
// (Group / Repeat / Switch / Encrypted) lives in its own sub-file under
// ./container-row/ so this dispatcher only has to pick the right one.

import type { ContainerPatch, EditAction, Path } from "@/lib/psml/edit-reducer";
import type { Container } from "@/lib/psml/types";

import { EncryptedEditor } from "./container-row/EncryptedEditor";
import { GroupEditor } from "./container-row/GroupEditor";
import { RepeatEditor } from "./container-row/RepeatEditor";
import { SwitchEditor } from "./container-row/SwitchEditor";

type Props = {
  container: Container;
  path: Path;
  dispatch: (a: EditAction) => void;
  siblingFieldIds: string[];
};

export default function ContainerRow({
  container,
  path,
  dispatch,
  siblingFieldIds,
}: Props) {
  const patch = (p: ContainerPatch) =>
    dispatch({ type: "update-container", at: path, patch: p });

  // ContainerRow only renders the compound variants. Plain Fields are
  // handled by FieldRow elsewhere in the studio.
  if (!("kind" in container)) return null;

  switch (container.kind) {
    case "group":
      return <GroupEditor container={container} patch={patch} />;
    case "repeat":
      return (
        <RepeatEditor
          container={container}
          patch={patch}
          siblingFieldIds={siblingFieldIds}
        />
      );
    case "switch":
      return (
        <SwitchEditor
          container={container}
          patch={patch}
          siblingFieldIds={siblingFieldIds}
        />
      );
    case "encrypted":
      return (
        <EncryptedEditor
          container={container}
          patch={patch}
          siblingFieldIds={siblingFieldIds}
        />
      );
    default:
      return null;
  }
}
