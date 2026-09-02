/** A stable textual form for hashing: object keys sorted at every depth, array
 * order preserved, `null` distinguished from an absent key.
 *
 * Written recursively rather than as `JSON.stringify(value, keyArray)`, whose
 * replacer-array form filters keys at EVERY depth — it would silently drop
 * nested model configuration such as `model.params.effort`, so two runs with
 * different reasoning effort would hash identically. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`cannot canonicalise the non-finite number ${value}`);
  }
  return JSON.stringify(value) ?? "null";
}
