type UsageTokens = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
};

/** Some ACP bridges split input into uncached/read/write buckets. */
export function inputTokensIncludingCache(usage: UsageTokens): number | undefined {
  const input = usage.inputTokens;
  const read = usage.cachedReadTokens ?? 0, write = usage.cachedWriteTokens ?? 0;
  const output = usage.outputTokens, total = usage.totalTokens;
  // A total that explicitly accounts for every bucket proves the split. An
  // inclusive input count, missing totals and ambiguous counters stay unchanged.
  if ([input, read, write, output, total].every(value => Number.isSafeInteger(value) && value! >= 0) &&
      total === input! + read + write + output!) return input! + read + write;
  return input;
}
