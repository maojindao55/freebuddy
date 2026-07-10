import type { ChatAttachment } from "@/services/cli/types";

const protectedManagedPaths = new Map<string, number>();

export function protectManagedAttachments(attachments: ChatAttachment[]): void {
  for (const attachment of attachments) {
    if (attachment.managed) {
      protectedManagedPaths.set(
        attachment.path,
        (protectedManagedPaths.get(attachment.path) ?? 0) + 1
      );
    }
  }
}

export function unprotectManagedAttachments(attachments: ChatAttachment[]): void {
  for (const attachment of attachments) {
    if (!attachment.managed) continue;
    const next = (protectedManagedPaths.get(attachment.path) ?? 0) - 1;
    if (next <= 0) protectedManagedPaths.delete(attachment.path);
    else protectedManagedPaths.set(attachment.path, next);
  }
}

export function isManagedAttachmentPathProtected(filePath: string): boolean {
  return (protectedManagedPaths.get(filePath) ?? 0) > 0;
}

export function resetManagedAttachmentProtectionForTests(): void {
  protectedManagedPaths.clear();
}
