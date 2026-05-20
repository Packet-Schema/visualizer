import type { Field, Packet } from "@/lib/psml/renderer";

export function selectableFieldId(packet: Packet, field: Field): string {
  const groupId = field.sourceTopLevelGroupId;
  if (groupId) {
    const parent = packet.fields.find(
      (candidate) => candidate.id === groupId && candidate.subfields?.length,
    );
    if (parent?.subfields?.some((sub) => sub.id === field.id)) {
      return encodeSubfieldSelection(groupId, field.id);
    }
  }

  if (packet.fields.some((candidate) => candidate.id === field.id)) {
    return field.id;
  }

  return field.id;
}

const SUBFIELD_PREFIX = "subfield";

export function encodeSubfieldSelection(
  parentId: string,
  subId: string,
): string {
  return `${SUBFIELD_PREFIX}:${parentId.length}:${parentId}${subId.length}:${subId}`;
}

export function decodeSubfieldSelection(
  selectedFieldId: string,
): { parentId: string; subId: string } | null {
  if (!selectedFieldId.startsWith(`${SUBFIELD_PREFIX}:`)) return null;
  const payload = selectedFieldId.slice(`${SUBFIELD_PREFIX}:`.length);
  const parentLenEnd = payload.indexOf(":");
  if (parentLenEnd < 0) return null;
  const parentLen = Number(payload.slice(0, parentLenEnd));
  if (!Number.isInteger(parentLen) || parentLen < 0) return null;
  const parentStart = parentLenEnd + 1;
  const parentId = payload.slice(parentStart, parentStart + parentLen);
  if (parentId.length !== parentLen) return null;
  const subLenStart = parentStart + parentLen;
  const subLenEnd = payload.indexOf(":", subLenStart);
  if (subLenEnd < 0) return null;
  const subLen = Number(payload.slice(subLenStart, subLenEnd));
  if (!Number.isInteger(subLen) || subLen < 0) return null;
  const subStart = subLenEnd + 1;
  const subId = payload.slice(subStart, subStart + subLen);
  if (subId.length !== subLen) return null;
  if (subStart + subLen !== payload.length) return null;
  return { parentId, subId };
}
