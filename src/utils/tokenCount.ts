const compactTokens = new Intl.NumberFormat("en", { notation: "compact", maximumSignificantDigits: 3 });

export function formatTokenCount(value: number | undefined): string {
  return value === undefined ? "—" : compactTokens.format(value);
}
