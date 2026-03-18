export function parseNdjsonLine(line: string): unknown | null {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (trimmed.length === 0) {
    return null;
  }

  return JSON.parse(trimmed) as unknown;
}

export function serializeNdjsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
