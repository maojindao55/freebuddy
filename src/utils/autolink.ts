export type AutolinkSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string; href: string };

const BARE_URL_RE = /\bhttps?:\/\/[^\s<>\[\]"'`]+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?，。；：！？、）》」』】…]+$/u;

function trimUrlMatch(raw: string): { href: string; trailing: string } {
  let href = raw;
  let trailing = "";

  const punct = href.match(TRAILING_PUNCT_RE);
  if (punct) {
    trailing = punct[0];
    href = href.slice(0, -trailing.length);
  }

  while (
    (href.endsWith(")") && countChar(href, "(") < countChar(href, ")")) ||
    (href.endsWith("]") && countChar(href, "[") < countChar(href, "]")) ||
    (href.endsWith("}") && countChar(href, "{") < countChar(href, "}"))
  ) {
    trailing = href.slice(-1) + trailing;
    href = href.slice(0, -1);
  }

  return { href, trailing };
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (const current of value) {
    if (current === char) count += 1;
  }
  return count;
}

/** Split plain text into text/link segments for bubble autolinking. */
export function splitAutolinkSegments(text: string): AutolinkSegment[] {
  if (!text) return [];

  const segments: AutolinkSegment[] = [];
  let lastIndex = 0;
  BARE_URL_RE.lastIndex = 0;

  for (const match of text.matchAll(BARE_URL_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, index) });
    }

    const { href, trailing } = trimUrlMatch(match[0]);
    if (/^https?:\/\//i.test(href)) {
      segments.push({ kind: "link", value: href, href });
    } else if (match[0]) {
      segments.push({ kind: "text", value: match[0] });
      lastIndex = index + match[0].length;
      continue;
    }

    if (trailing) {
      segments.push({ kind: "text", value: trailing });
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ kind: "text", value: text }];
}
