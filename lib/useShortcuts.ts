import { useEffect, useRef } from 'react';

type Shortcuts = {
  /** The active view's id (the URL hash). */
  view: string;
  recording: boolean;
  connected: boolean;
  toggleRecord: () => void;
  /** Zero-based position in the navigation order. */
  goTo: (index: number) => void;
  toggleChart: () => void;
  openHelp: () => void;
};

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const CONTROL = 'button, a[href], summary, [role="button"], [role="switch"], [role="checkbox"], [role="tab"]';
// Views that show a Start/Stop Logging button; Space does nothing elsewhere (Pass/Fail
// captures verdicts itself and has none).
const RECORD_VIEWS: readonly string[] = ['dashboard', 'data-log'];

// Every overlay in the app is `aria-modal` (ConfirmDialog, NoDataWarning, an open Drawer,
// ShortcutHelp), so one selector suppresses all of them — a new overlay must carry it too.
function suppressed(e: KeyboardEvent, target: Element | null): boolean {
  return e.defaultPrevented || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey
    || !!document.querySelector('[aria-modal="true"]')
    || !!target?.closest(EDITABLE);
}

// Physical key, so a non-Latin layout (H types `р` on Ukrainian) still works; `?` is the
// exception, tested first: it is the character that matters, not its position.
function actionFor(e: KeyboardEvent, s: Shortcuts, target: Element | null, byKeyboard: boolean) {
  if (e.key === '?') return s.openHelp;
  if (e.code === 'Space') {
    // A control Tab focused keeps Space (it would click twice); one a mouse click focused
    // does not, so Space still toggles logging and preventDefault stops its click.
    const onControl = byKeyboard && !!target?.closest(CONTROL);
    const canToggle = s.recording || s.connected;
    return !onControl && canToggle && RECORD_VIEWS.includes(s.view) ? s.toggleRecord : null;
  }
  if (e.code === 'KeyH') return s.view === 'dashboard' ? s.toggleChart : null;
  const n = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
  return n ? () => s.goTo(Number(n[1]) - 1) : null;
}

// One window listener, attached once: the callbacks are read from a ref so the page's
// serial-rate re-renders never rebind it.
export function useShortcuts(shortcuts: Shortcuts) {
  const ref = useRef(shortcuts);
  useEffect(() => { ref.current = shortcuts; });

  useEffect(() => {
    // How focus last arrived. `:focus-visible` cannot say: Chrome sets it on the very Space
    // keydown being handled, even for a button the mouse focused.
    let byKeyboard = false;
    const onPointer = () => { byKeyboard = false; };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') byKeyboard = true;
      const target = e.target instanceof Element ? e.target : null;
      if (suppressed(e, target)) return;
      const act = actionFor(e, ref.current, target, byKeyboard);
      if (!act) return;
      e.preventDefault();
      act();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);
}
