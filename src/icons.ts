import type { Kind } from './types';

const CORE_PACKAGES = new Set(['builtins', 'syntax']);

/** Kind -> VS Code codicon class (the exact glyphs Pylance's own IntelliSense uses). */
const KIND_ICON: Record<Kind, string> = {
  module: 'codicon-symbol-module',
  package: 'codicon-symbol-package',
  class: 'codicon-symbol-class',
  function: 'codicon-symbol-function',
  method: 'codicon-symbol-method',
  property: 'codicon-symbol-property',
  constant: 'codicon-symbol-constant',
  variable: 'codicon-symbol-variable',
  instance: 'codicon-symbol-object',
  keyword: 'codicon-symbol-keyword',
  operator: 'codicon-symbol-operator',
  syntax: 'codicon-symbol-misc',
  call: 'codicon-symbol-parameter',
  formatting: 'codicon-symbol-string',
  punctuation: 'codicon-symbol-misc',
  unknown: 'codicon-symbol-misc',
};

/** Kind -> VS Code Dark+ semantic color, matching the editor's own token colors. */
const KIND_COLOR: Record<Kind, string> = {
  module: 'var(--oi-c-module)',
  package: 'var(--oi-c-module)',
  class: 'var(--oi-c-class)',
  function: 'var(--oi-c-function)',
  method: 'var(--oi-c-function)',
  property: 'var(--oi-c-property)',
  constant: 'var(--oi-c-constant)',
  variable: 'var(--oi-c-constant)',
  instance: 'var(--oi-c-foreground)',
  keyword: 'var(--oi-c-module)',
  operator: 'var(--oi-c-constant)',
  syntax: 'var(--oi-c-property)',
  call: 'var(--oi-c-call)',
  formatting: 'var(--oi-c-string)',
  punctuation: 'var(--oi-c-property)',
  unknown: 'var(--oi-c-foreground)',
};

export function isCorePackage(name: string | undefined): boolean {
  return !!name && CORE_PACKAGES.has(name);
}

function isCorePackageIcon(kind: Kind, pkg?: string): boolean {
  return kind === 'package' && isCorePackage(pkg);
}

export function iconClassFor(kind: Kind, pkg?: string): string {
  if (isCorePackageIcon(kind, pkg)) return 'codicon-library';
  return KIND_ICON[kind] ?? KIND_ICON.unknown;
}

export function colorFor(kind: Kind, pkg?: string): string {
  if (isCorePackageIcon(kind, pkg)) return 'var(--oi-c-core)';
  return KIND_COLOR[kind] ?? KIND_COLOR.unknown;
}

export function iconEl(kind: Kind, pkg?: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `codicon ${iconClassFor(kind, pkg)} oi-icon`;
  if (isCorePackageIcon(kind, pkg)) span.classList.add('oi-icon-core');
  span.style.color = colorFor(kind, pkg);
  span.setAttribute('aria-hidden', 'true');
  return span;
}
