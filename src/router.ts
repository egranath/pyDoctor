export type Route =
  | { kind: 'home' }
  | { kind: 'object'; pkg: string; path: string };

export interface ViewState {
  contentScrollTop: number;
  open: Record<string, boolean>;
  scrolls: Record<string, number>;
}

type Listener = (route: Route) => void;
type NavListener = () => void;

let listener: Listener | null = null;
let navListener: NavListener | null = null;

let _histPos: number = (() => {
  try { return ((history.state as Record<string, unknown> | null)?.db_hist_pos as number) ?? 0; } catch { return 0; }
})();
let _histMax: number = (() => {
  try { return Math.max(Number(sessionStorage.getItem('db_hist_max')) || 0, _histPos); } catch { return _histPos; }
})();

export function hrefFor(pkg: string, path: string): string {
  return `?pkg=${encodeURIComponent(pkg)}&path=${encodeURIComponent(path)}`;
}

export function getNavState(): { canGoBack: boolean; canGoForward: boolean } {
  return { canGoBack: _histPos > 0, canGoForward: _histPos < _histMax };
}

export function onNavStateChange(cb: NavListener): void {
  navListener = cb;
}

export function parseCurrentRoute(): Route {
  const params = new URLSearchParams(window.location.search);
  const pkg = params.get('pkg') ?? undefined;
  const path = params.get('path') ?? pkg;
  if (pkg && path) return { kind: 'object', pkg, path };
  if (path) return { kind: 'object', pkg: path.split('.')[0] ?? path, path };
  return { kind: 'home' };
}

export function onRouteChange(cb: Listener): void {
  listener = cb;
  window.addEventListener('popstate', () => {
    try { _histPos = ((history.state as Record<string, unknown> | null)?.db_hist_pos as number) ?? 0; } catch {}
    navListener?.();
    listener?.(parseCurrentRoute());
  });
}

export function navigateToPath(
  pkg: string,
  path: string,
  { replace = false }: { replace?: boolean } = {},
): void {
  const url = hrefFor(pkg, path);
  const state = { db_hist_pos: _histPos, pkg, path };
  const current = window.location.search;
  const same = current === url || current === `/${url}`;
  if (same) {
    commitHistory('replace', { ...state, db_hist_pos: _histPos }, url);
    return;
  }
  if (replace) {
    commitHistory('replace', state, url);
  } else {
    const next = _histPos + 1;
    if (!commitHistory('push', { ...state, db_hist_pos: next }, url)) return;
    _histPos = next;
    _histMax = next;
    try { sessionStorage.setItem('db_hist_max', String(_histMax)); } catch {}
  }
  navListener?.();
}

export function navigateHome({ replace = false }: { replace?: boolean } = {}): void {
  const atHome = !window.location.search || window.location.search === '?';
  if (atHome) return;
  if (replace) {
    commitHistory('replace', { db_hist_pos: _histPos }, window.location.pathname || './');
  } else {
    const next = _histPos + 1;
    if (!commitHistory('push', { db_hist_pos: next }, window.location.pathname || './')) return;
    _histPos = next;
    _histMax = next;
    try { sessionStorage.setItem('db_hist_max', String(_histMax)); } catch {}
  }
  navListener?.();
}

function commitHistory(mode: 'push' | 'replace', data: unknown, url?: string): boolean {
  try {
    if (mode === 'push') history.pushState(data, '', url);
    else history.replaceState(data, '', url);
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'SecurityError') return false;
    throw err;
  }
}

export function persistViewState(view: ViewState): void {
  try {
    const prev = (history.state && typeof history.state === 'object')
      ? { ...(history.state as Record<string, unknown>) }
      : {};
    history.replaceState({ ...prev, db_hist_pos: _histPos, db_view: view }, '');
  } catch { /* quota / security */ }
}

export function readViewState(): ViewState | undefined {
  try {
    const raw = (history.state as Record<string, unknown> | null)?.db_view;
    if (!raw || typeof raw !== 'object') return undefined;
    const view = raw as ViewState;
    if (typeof view.contentScrollTop !== 'number' || !view.open || !view.scrolls) return undefined;
    return view;
  } catch {
    return undefined;
  }
}

export function goBack(): void {
  history.back();
}

export function goForward(): void {
  history.forward();
}
