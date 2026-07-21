export function toJsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

export function parseJsonl<T>(content: string): T[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
