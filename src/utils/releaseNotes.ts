const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "details",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul"
]);

const DROP_TAGS = new Set([
  "audio",
  "button",
  "embed",
  "form",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "object",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "video"
]);

const GLOBAL_ATTRS = new Set(["aria-label", "title"]);
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const SAFE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

export function formatReleaseNotes(notes: unknown): string | null {
  if (!notes) return null;
  if (typeof notes === "string") return notes.trim() || null;
  if (Array.isArray(notes)) {
    const text = notes
      .map((n) => (typeof n === "string" ? n : (n as { note?: string })?.note ?? ""))
      .filter(Boolean)
      .join("\n\n");
    return text.trim() || null;
  }
  return null;
}

export function isReleaseNotesHtml(text: string): boolean {
  return /<\/?(?:a|abbr|b|blockquote|br|code|del|details|div|em|h[1-6]|hr|i|img|ins|kbd|li|ol|p|pre|s|span|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|tr|u|ul)\b/i.test(
    text
  );
}

function safeUrl(value: string, protocols: Set<string>): string | null {
  try {
    const url = new URL(value, "https://github.com");
    return protocols.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function sanitizeAttributes(source: Element, target: Element, tag: string): void {
  for (const attr of Array.from(source.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    if (name.startsWith("on") || name === "style") continue;

    if (GLOBAL_ATTRS.has(name)) {
      target.setAttribute(name, value);
      continue;
    }

    if (tag === "a" && name === "href") {
      const url = safeUrl(value, SAFE_LINK_PROTOCOLS);
      if (url) target.setAttribute("href", url);
      continue;
    }

    if (tag === "img") {
      if (name === "src") {
        const url = safeUrl(value, SAFE_IMAGE_PROTOCOLS);
        if (url) target.setAttribute("src", url);
      } else if (name === "alt") {
        target.setAttribute("alt", value);
      } else if ((name === "width" || name === "height") && /^\d{1,4}$/.test(value)) {
        target.setAttribute(name, value);
      }
      continue;
    }

    if ((tag === "td" || tag === "th") && ["align", "colspan", "rowspan"].includes(name)) {
      target.setAttribute(name, value);
      continue;
    }

    if (tag === "ol" && name === "start" && /^\d+$/.test(value)) {
      target.setAttribute(name, value);
      continue;
    }

    if (tag === "details" && name === "open") {
      target.setAttribute("open", "");
    }
  }

  if (tag === "a" && target.hasAttribute("href")) {
    target.setAttribute("target", "_blank");
    target.setAttribute("rel", "noreferrer noopener");
  }
}

export function sanitizeReleaseNotesHtml(html: string): string {
  if (typeof DOMParser === "undefined") return "";

  const doc = new DOMParser().parseFromString(html, "text/html");
  const clean = doc.createElement("div");

  const sanitizeNode = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      return doc.createTextNode(node.textContent ?? "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) return null;

    if (!ALLOWED_TAGS.has(tag)) {
      const fragment = doc.createDocumentFragment();
      for (const child of Array.from(element.childNodes)) {
        const sanitized = sanitizeNode(child);
        if (sanitized) fragment.appendChild(sanitized);
      }
      return fragment;
    }

    const cleanElement = doc.createElement(tag);
    sanitizeAttributes(element, cleanElement, tag);
    for (const child of Array.from(element.childNodes)) {
      const sanitized = sanitizeNode(child);
      if (sanitized) cleanElement.appendChild(sanitized);
    }
    return cleanElement;
  };

  for (const child of Array.from(doc.body.childNodes)) {
    const sanitized = sanitizeNode(child);
    if (sanitized) clean.appendChild(sanitized);
  }

  return clean.innerHTML;
}
