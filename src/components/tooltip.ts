import { computePosition, offset, flip, shift, type Placement } from '@floating-ui/dom';

export const TOOLTIP_DELAY_MS = 700;

let activeTooltip: HTMLDivElement | null = null;
let showTimer: number | undefined;

export function hideTooltip(): void {
  if (showTimer) {
    window.clearTimeout(showTimer);
    showTimer = undefined;
  }
  activeTooltip?.remove();
  activeTooltip = null;
}

/**
 * Attach a VS Code hover-style tooltip to `el`, shown after a short delay
 * on mouseenter (so casual mouse-overs don't spam popups), positioned by
 * Floating UI to stay on screen near the element.
 *
 * `hideTooltip` is exported so the router and nav buttons can call it on
 * any navigation event - otherwise a tooltip opened just before a click
 * can survive indefinitely in the new view because its `mouseleave` event
 * never fires (the element it was attached to is gone).
 */
export function attachTooltip(
  el: HTMLElement,
  contentHtml: () => string,
  placement: 'top-start' | 'bottom-start' = 'top-start',
  fallbackPlacements?: Placement[],
): void {
  el.addEventListener('mouseenter', () => {
    showTimer = window.setTimeout(async () => {
      hideTooltip();
      const tooltip = document.createElement('div');
      tooltip.className = 'oi-tooltip';
      tooltip.innerHTML = contentHtml();
      document.body.appendChild(tooltip);
      activeTooltip = tooltip;

      const { x, y } = await computePosition(el, tooltip, {
        placement,
        middleware: [
          offset(6),
          flip(fallbackPlacements ? { fallbackPlacements } : {}),
          shift({ padding: 8 }),
        ],
      });
      // Guard: element may have been removed while we awaited positioning.
      if (activeTooltip === tooltip) {
        Object.assign(tooltip.style, { left: `${x}px`, top: `${y}px` });
      } else {
        tooltip.remove();
      }
    }, TOOLTIP_DELAY_MS);
  });

  el.addEventListener('mouseleave', hideTooltip);
  // Also hide on any click anywhere inside the element (covers link clicks
  // that immediately replace the DOM, leaving no element to trigger mouseleave).
  el.addEventListener('mousedown', hideTooltip);
}
