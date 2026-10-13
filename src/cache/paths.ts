export function parentPath(path: string): string | null {
  const i = path.lastIndexOf('.');
  return i === -1 ? null : path.slice(0, i);
}

export function lastSegment(path: string): string {
  return path.split('.').at(-1) ?? path;
}

/** API-private / dunder names. `_` alone is the match wildcard, not private. */
export function isPrivateSegment(name: string): boolean {
  return name.startsWith('_') && name !== '_';
}
