import {
  createChatAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  validateAttachmentCandidate,
  type AttachmentCandidate,
  type ChatAttachment
} from "./chatAttachments";

export type MergeAttachmentWarningCode =
  | "attachmentLimit"
  | "attachmentType"
  | "attachmentTooLarge";

export interface MergeAttachmentWarning {
  code: MergeAttachmentWarningCode;
  name?: string;
}

export function mergeSelectedAttachments(
  current: readonly ChatAttachment[],
  selected: readonly AttachmentCandidate[],
  maxAttachments: number = MAX_ATTACHMENTS_PER_MESSAGE
): {
  attachments: ChatAttachment[];
  warnings: MergeAttachmentWarning[];
  overflow: boolean;
} {
  const byPath = new Map(current.map((attachment) => [attachment.path, attachment]));
  const warnings: MergeAttachmentWarning[] = [];
  let overflow = false;

  for (const candidate of selected) {
    const attachment = createChatAttachment(candidate);
    const validation = validateAttachmentCandidate(attachment);
    if (!validation.ok) {
      warnings.push({
        code:
          validation.reason === "file_too_large"
            ? "attachmentTooLarge"
            : "attachmentType",
        name: candidate.name || candidate.path
      });
      continue;
    }
    if (!attachment || byPath.has(attachment.path)) continue;
    if (byPath.size >= maxAttachments) {
      overflow = true;
      continue;
    }
    byPath.set(attachment.path, attachment);
  }

  if (overflow) {
    warnings.push({ code: "attachmentLimit" });
  }

  return {
    attachments: Array.from(byPath.values()),
    warnings,
    overflow
  };
}

export function shouldDiscardCreatedManagedCandidate(candidate: {
  managed?: boolean;
  created?: boolean;
  path?: string;
}): boolean {
  return (
    candidate.created === true &&
    candidate.managed === true &&
    typeof candidate.path === "string" &&
    candidate.path.length > 0
  );
}
