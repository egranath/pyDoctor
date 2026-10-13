const UNLOADED_KEY = 'db_show_unloaded';

type Listener = (value: boolean) => void;

function readPref(): boolean {
  try {
    return localStorage.getItem(UNLOADED_KEY) === 'true';
  } catch {
    return false;
  }
}

let value = readPref();
const listeners = new Set<Listener>();

export function getShowUnloaded(): boolean {
  return value;
}

export function setShowUnloaded(next: boolean): void {
  if (value === next) return;
  value = next;
  try {
    localStorage.setItem(UNLOADED_KEY, String(next));
  } catch {
    // ignore quota / private mode
  }
  for (const listener of listeners) listener(value);
}

export function subscribeShowUnloaded(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
