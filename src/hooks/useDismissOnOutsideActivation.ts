import { useEffect, type RefObject } from "react";

/**
 * Close a manually-controlled overlay (open flag driven by row events, not by
 * an antd trigger) when activation lands outside the anchor element. The antd
 * popup renders in a portal, so elements inside `.ant-dropdown` count as
 * inside; every other outside activation closes.
 */
export function useDismissOnOutsideActivation({ active, anchor, onClose }: {
  active: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!active) return;
    // Capture phase: the row content stopPropagation()s click events, which
    // must not keep the menu open once activation lands outside it.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (anchor.current?.contains(target)) return;
      if (target.closest(".ant-dropdown")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [active, anchor, onClose]);
}
