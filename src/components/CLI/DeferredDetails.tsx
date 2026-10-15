import { useEffect, useState, type DetailsHTMLAttributes, type ReactNode } from "react";

/** Native details keeps keyboard/toggle behavior; closed bodies do no render work. */
export function DeferredDetails({
  summary, children, open, onToggle, ...props
}: Omit<DetailsHTMLAttributes<HTMLDetailsElement>, "children"> & {
  summary: ReactNode;
  children: () => ReactNode;
}) {
  const [expanded, setExpanded] = useState(Boolean(open));
  useEffect(() => {
    if (open !== undefined) setExpanded(open);
  }, [open]);
  return (
    <details {...props} open={open} onToggle={event => {
      setExpanded(event.currentTarget.open);
      onToggle?.(event);
    }}>
      {summary}
      {expanded ? children() : null}
    </details>
  );
}
