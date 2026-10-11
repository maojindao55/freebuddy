/** Repair the office engine's occasional JSON Schema objects encoded as entries. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entryObject(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries: Array<[string, unknown]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== "string") return null;
    const [, first, ...extra] = entry;
    if (extra.length > 0) {
      // editor_sdk also appends property pairs after a ["properties", {...}] entry.
      const extraProperties = entryObject(extra);
      if (!isRecord(first) || !extraProperties) return null;
      entries.push([entry[0], { ...first, ...extraProperties }]);
    } else {
      entries.push([entry[0], first]);
    }
  }
  return Object.fromEntries(entries);
}

function normalizeSchemaMap(value: unknown): unknown {
  const map = entryObject(value) ?? value;
  if (!isRecord(map)) return map;
  return Object.fromEntries(
    Object.entries(map).map(([name, schema]) => [name, normalizeOfficeToolSchema(schema)])
  );
}

/** Preserve real schema arrays (enum, required, anyOf) while repairing schema nodes. */
export function normalizeOfficeToolSchema(value: unknown): unknown {
  const schema = entryObject(value) ?? value;
  if (!isRecord(schema)) return schema;
  const normalized = { ...schema };
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    if (key in normalized) normalized[key] = normalizeSchemaMap(normalized[key]);
  }
  for (const key of [
    "items", "additionalProperties", "unevaluatedProperties", "contains", "not", "if", "then", "else", "propertyNames"
  ]) {
    if (key in normalized) normalized[key] = normalizeOfficeToolSchema(normalized[key]);
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (Array.isArray(normalized[key])) {
      normalized[key] = normalized[key].map((child) => normalizeOfficeToolSchema(child));
    }
  }
  return normalized;
}
