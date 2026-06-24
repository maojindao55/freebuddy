import { create } from "zustand";

import type { ExtractedInlineImage } from "@/utils/streamMedia";

interface ImagePreviewState {
  byKey: Record<string, string>;
  register: (image: ExtractedInlineImage) => string;
}

function previewKeyFor(image: ExtractedInlineImage): string {
  return `img_${image.mimeType}_${image.data.length}_${image.data.slice(0, 48)}`;
}

export const useImagePreviewStore = create<ImagePreviewState>((set, get) => ({
  byKey: {},
  register: (image) => {
    const key = previewKeyFor(image);
    const dataUrl = `data:${image.mimeType};base64,${image.data}`;
    const existing = get().byKey[key];
    if (existing) return key;
    set((state) => ({
      byKey: {
        ...state.byKey,
        [key]: dataUrl
      }
    }));
    return key;
  }
}));
