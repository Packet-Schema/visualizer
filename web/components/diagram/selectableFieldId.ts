import type { Field, Packet } from "@/lib/psml/renderer";

export function selectableFieldId(packet: Packet, field: Field): string {
  const groupId = field.sourceTopLevelGroupId;
  if (groupId) {
    const parent = packet.fields.find((candidate) => candidate.id === groupId);
    if (parent?.subfields?.some((sub) => sub.id === field.id)) {
      return `${groupId}:${field.id}`;
    }
  }

  if (packet.fields.some((candidate) => candidate.id === field.id)) {
    return field.id;
  }

  return field.id;
}
