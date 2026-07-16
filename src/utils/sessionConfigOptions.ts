export type SessionConfigOptionLike = {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  currentLabel?: string;
  description?: string;
  values?: { id: string; name?: string }[];
};

const PICKER_CATEGORIES = new Set(["model", "model_config", "thought_level"]);

export function isSessionConfigPickerOption(
  option: SessionConfigOptionLike
): boolean {
  if (option.category && PICKER_CATEGORIES.has(option.category)) return true;
  return option.id === "model";
}

/** Ensure thought_level always offers `none` (Issue #59, approach A). */
export function ensureThoughtLevelNoneOption(
  options: SessionConfigOptionLike[]
): SessionConfigOptionLike[] {
  return options.map((option) => {
    if (option.category !== "thought_level") return option;
    const values = option.values ?? [];
    if (values.some((value) => value.id === "none")) return option;
    return {
      ...option,
      values: [{ id: "none" }, ...values]
    };
  });
}

export function filterSessionConfigPickerOptions(
  options: SessionConfigOptionLike[]
): SessionConfigOptionLike[] {
  return ensureThoughtLevelNoneOption(
    options.filter(isSessionConfigPickerOption)
  );
}

export function displayConfigOptionValue(
  option: SessionConfigOptionLike,
  overrides: Record<string, string> | undefined
): string | undefined {
  const override = overrides?.[option.id];
  if (override != null && override !== "") return override;
  return option.currentValue;
}

export function configOptionChoiceLabel(
  value: { id: string; name?: string },
  noneLabel = "Off"
): string {
  if (value.name) return value.name;
  if (value.id === "none") return noneLabel;
  return value.id;
}

export function displayConfigOptionLabel(
  option: SessionConfigOptionLike,
  overrides: Record<string, string> | undefined,
  labels?: { none?: string }
): string | undefined {
  const value = displayConfigOptionValue(option, overrides);
  if (!value) return option.currentLabel ?? option.name;
  const match = option.values?.find((v) => v.id === value);
  const raw =
    match?.name ??
    (value === option.currentValue ? option.currentLabel : undefined) ??
    value;
  if ((!match?.name && value === "none") || raw === "none") {
    return labels?.none ?? "Off";
  }
  return raw;
}

export function pruneConfigOptionOverrides(
  overrides: Record<string, string> | undefined,
  options: SessionConfigOptionLike[]
): Record<string, string> {
  if (!overrides) return {};
  const allowed = new Set(options.map((o) => o.id));
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(overrides)) {
    if (allowed.has(id) && value != null && value !== "") out[id] = value;
  }
  return out;
}

export function reconcileConfigOptionOverrides(
  overrides: Record<string, string> | undefined,
  options: SessionConfigOptionLike[]
): Record<string, string> {
  if (!overrides) return {};
  const currentById = new Map<string, string | undefined>();
  for (const o of options) {
    if (!currentById.has(o.id)) {
      currentById.set(o.id, o.currentValue);
    }
  }
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(overrides)) {
    if (value == null || value === "") continue;
    if (currentById.get(id) === value) continue;
    out[id] = value;
  }
  return out;
}
