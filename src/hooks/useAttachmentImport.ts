import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";

import {
  extractFilesFromClipboard,
  extractFilesFromDataTransfer,
  hasFileTransfer
} from "@/utils/attachmentImport";

export function useAttachmentImport(options: {
  disabled: boolean;
  onImport: (files: File[]) => void;
}) {
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  const canAcceptFiles = !options.disabled;

  const resetDrag = () => {
    dragDepthRef.current = 0;
    setDragActive(false);
  };

  const handleDragEnter = (event: DragEvent) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    if (!canAcceptFiles) return;
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragLeave = (event: DragEvent) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const handleDragOver = (event: DragEvent) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canAcceptFiles ? "copy" : "none";
  };

  const handleDrop = (event: DragEvent) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    resetDrag();
    if (!canAcceptFiles) return;
    const files = extractFilesFromDataTransfer(event.dataTransfer);
    if (files.length > 0) options.onImport(files);
  };

  const handlePaste = (event: ClipboardEvent) => {
    if (!canAcceptFiles) return;
    const files = extractFilesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    options.onImport(files);
  };

  return {
    dragActive,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handlePaste
  };
}
