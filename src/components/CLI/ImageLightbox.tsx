import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

interface LightboxState {
  src: string;
  alt?: string;
}

interface LightboxContextValue {
  open: (state: LightboxState) => void;
}

interface LightboxView {
  zoom: number;
  x: number;
  y: number;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 10;
const DEFAULT_VIEW: LightboxView = { zoom: 1, x: 0, y: 0 };

const LightboxContext = createContext<LightboxContextValue | null>(null);

export function ImageLightboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LightboxState | null>(null);
  const [view, setView] = useState<LightboxView>(DEFAULT_VIEW);
  const [dragging, setDragging] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const suppressClickRef = useRef(false);
  const { t } = useTranslation();

  const open = useCallback((next: LightboxState) => {
    setView(DEFAULT_VIEW);
    setState(next);
  }, []);
  const close = useCallback(() => setState(null), []);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    setView((prev) => {
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev.zoom * factor));
      if (zoom === prev.zoom) return prev;
      const rect = imgRef.current?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      const ratio = zoom / prev.zoom;
      return {
        zoom,
        x: prev.x + (clientX - cx) * (1 - ratio),
        y: prev.y + (clientY - cy) * (1 - ratio)
      };
    });
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (!event.ctrlKey && !event.metaKey) return;
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        zoomAt(cx, cy, 1.35);
      } else if (event.key === "-") {
        event.preventDefault();
        zoomAt(cx, cy, 1 / 1.35);
      } else if (event.key === "0") {
        event.preventDefault();
        setView(DEFAULT_VIEW);
      }
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [state, close, zoomAt]);

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!state || !backdrop) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.2 : 1 / 1.2);
    };
    backdrop.addEventListener("wheel", onWheel, { passive: false });
    return () => backdrop.removeEventListener("wheel", onWheel);
  }, [state, zoomAt]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) suppressClickRef.current = true;
      setView((prev) => ({ ...prev, x: drag.px + dx, y: drag.py + dy }));
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      if (suppressClickRef.current) {
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  return (
    <LightboxContext.Provider value={{ open }}>
      {children}
      {state ? (
        <div
          ref={backdropRef}
          className="image-lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={state.alt || t("lightbox.preview")}
          onClick={() => {
            if (suppressClickRef.current) return;
            close();
          }}
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
          <div
            className="image-lightbox-toolbar"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              aria-label={t("lightbox.zoomOut")}
              onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.35)}
            >
              <ZoomOut size={15} />
            </button>
            <span className="image-lightbox-zoom-value">{Math.round(view.zoom * 100)}%</span>
            <button
              type="button"
              aria-label={t("lightbox.zoomIn")}
              onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.35)}
            >
              <ZoomIn size={15} />
            </button>
            <button
              type="button"
              aria-label={t("lightbox.zoomReset")}
              onClick={() => setView(DEFAULT_VIEW)}
            >
              <RotateCcw size={15} />
            </button>
          </div>
          <figure
            className="image-lightbox-figure"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              ref={imgRef}
              src={state.src}
              alt={state.alt ?? ""}
              className="image-lightbox-img"
              draggable={false}
              style={{
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                cursor: view.zoom > 1 ? (dragging ? "grabbing" : "grab") : undefined
              }}
              onPointerDown={(event) => {
                if (view.zoom <= 1 || event.button !== 0) return;
                event.preventDefault();
                dragRef.current = {
                  x: event.clientX,
                  y: event.clientY,
                  px: view.x,
                  py: view.y
                };
                setDragging(true);
              }}
              onDoubleClick={(event) => {
                if (view.zoom === 1) zoomAt(event.clientX, event.clientY, 2);
                else setView(DEFAULT_VIEW);
              }}
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
