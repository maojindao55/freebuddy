import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface LightboxState {
  src: string;
  alt?: string;
}

interface LightboxContextValue {
  open: (state: LightboxState) => void;
}

const LightboxContext = createContext<LightboxContextValue | null>(null);

export function ImageLightboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LightboxState | null>(null);
  const { t } = useTranslation();

  const open = useCallback((next: LightboxState) => setState(next), []);
  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [state, close]);

  return (
    <LightboxContext.Provider value={{ open }}>
      {children}
      {state ? (
        <div
          className="image-lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={state.alt || t("lightbox.preview")}
          onClick={close}
        >
          <button
            type="button"
            className="image-lightbox-close"
            aria-label={t("lightbox.close")}
            onClick={(event) => {
              event.stopPropagation();
              close();
            }}
          >
            ✕
          </button>
          <figure
            className="image-lightbox-figure"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={state.src}
              alt={state.alt ?? ""}
              className="image-lightbox-img"
            />
            {state.alt ? (
              <figcaption className="image-lightbox-caption">{state.alt}</figcaption>
            ) : null}
          </figure>
        </div>
      ) : null}
    </LightboxContext.Provider>
  );
}

export function useImageLightbox(): LightboxContextValue {
  const ctx = useContext(LightboxContext);
  if (!ctx) {
    return {
      open: () => {
        /* no-op when provider is missing */
      }
    };
  }
  return ctx;
}
