const MARKDOWN_KEY = 'db_doc_markdown';

type Listener = (value: boolean) => void;

function readPref(): boolean {
  try {
    const raw = localStorage.getItem(MARKDOWN_KEY);
    if (raw === null) return true;
    return raw === 'true';
  } catch {
    return true;
  }
}

let value = readPref();
const listeners = new Set<Listener>();

export function getDocMarkdown(): boolean {
  return value;
}

export function setDocMarkdown(next: boolean): void {
  if (value === next) return;
  value = next;
  try {
    localStorage.setItem(MARKDOWN_KEY, String(next));
  } catch {
    // ignore quota / private mode
  }
  for (const listener of listeners) listener(value);
}

export function subscribeDocMarkdown(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
