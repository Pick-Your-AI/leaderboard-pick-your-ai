/** Parse downloaded export JSON without silently discarding duplicate members.
 * Bounds match the producer's maximum nesting; transport has its own byte cap. */
export function parseExportJSON(raw: string): unknown {
  if (raw.length > 2_000_000) throw new Error("invalid_export_json");
  const stack: ({ keys: Set<string>; expectKey: boolean } | null)[] = [];
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '"') {
      const start = index++;
      let closed = false;
      for (; index < raw.length; index++) {
        if (raw[index] === "\\") index++;
        else if (raw[index] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("invalid_export_json");
      const container = stack.at(-1);
      if (container?.expectKey) {
        const key: unknown = JSON.parse(raw.slice(start, index + 1));
        if (typeof key !== "string" || container.keys.has(key)) throw new Error("invalid_export_json");
        container.keys.add(key);
        container.expectKey = false;
      }
    } else if (character === "{" || character === "[") {
      stack.push(character === "{" ? { keys: new Set(), expectKey: true } : null);
      if (stack.length > 25) throw new Error("invalid_export_json");
    } else if (character === "}" || character === "]") stack.pop();
    else if (character === ",") {
      const container = stack.at(-1);
      if (container) container.expectKey = true;
    }
  }
  // The native parser remains authoritative for syntax, escapes and values.
  return JSON.parse(raw);
}

/** Original download bytes are retained, so ignored fields cannot be allowed to
 * carry unprojected data that is absent from the validated public object. */
export function onlyExportKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("invalid_export_field");
}
