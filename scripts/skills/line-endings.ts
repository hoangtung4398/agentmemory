export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function hasAutogenDrift(existing: string, next: string): boolean {
  return normalizeLineEndings(existing) !== normalizeLineEndings(next);
}
