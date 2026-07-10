export function hasFileTransfer(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

export function extractFilesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  const files: File[] = [];
  for (const file of dataTransfer.files) {
    if (file) files.push(file);
  }
  return files;
}

export function extractFilesFromClipboard(data: DataTransfer): File[] {
  if (data.files.length > 0) {
    return extractFilesFromDataTransfer(data);
  }

  const files: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

export function isDeferredAttachmentImportStillValid(args: {
  capturedGeneration: number;
  currentGeneration: number;
  sendLockBlocked: boolean;
  canImport?: boolean;
}): boolean {
  const { capturedGeneration, currentGeneration, sendLockBlocked, canImport = true } = args;
  return (
    capturedGeneration === currentGeneration &&
    !sendLockBlocked &&
    canImport
  );
}

export function resolveDeferredAttachmentImport<T>(args: {
  capturedGeneration: number;
  currentGeneration: number;
  sendLockBlocked: boolean;
  canImport: boolean;
  selected: readonly T[];
}): { shouldApply: boolean; selected: readonly T[] } {
  if (
    !isDeferredAttachmentImportStillValid({
      capturedGeneration: args.capturedGeneration,
      currentGeneration: args.currentGeneration,
      sendLockBlocked: args.sendLockBlocked,
      canImport: args.canImport
    })
  ) {
    return { shouldApply: false, selected: args.selected };
  }
  if (args.selected.length === 0) {
    return { shouldApply: false, selected: args.selected };
  }
  return { shouldApply: true, selected: args.selected };
}
