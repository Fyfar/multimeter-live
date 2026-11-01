'use client';

import { useEffect, useEffectEvent, useRef, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { X } from 'lucide-react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Below lg: a modal panel sliding in from the right edge. At lg it is exactly the element
// the caller styled (an inline aside): every narrow-only class here is max-lg:, and `open`
// is only ever true below lg — openers are lg:hidden and growing to lg closes it — so the
// dialog role never reaches the desktop layout.
export function Drawer({
  open,
  onClose,
  label,
  className,
  as: Tag = 'aside',
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  className?: string;
  as?: 'aside' | 'div';
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Callers pass inline lambdas and re-render at the serial rate; reading onClose through
  // an effect event keeps the effect below keyed on `open` alone, so focus is not yanked
  // back to the close button mid-typing.
  const close = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    // A modal above this drawer (ConfirmDialog, NoDataWarning — both aria-modal) owns the
    // keyboard. Window capture runs before their document listeners, so a dialog Escape is
    // about to close is still in the DOM here, whatever order React commits in.
    const covered = () =>
      Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => el !== panel);
    const onKey = (e: KeyboardEvent) => {
      if (!panel || covered()) return;
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      const inside = at instanceof Node && panel.contains(at);
      if (e.shiftKey && (!inside || at === first)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (!inside || at === last)) {
        e.preventDefault();
        first?.focus();
      }
    };
    // Same breakpoint as Tailwind's lg (64rem, not 1024px: rem follows the font setting).
    const wide = window.matchMedia('(min-width: 64rem)');
    const onWide = () => {
      if (wide.matches) close();
    };
    window.addEventListener('keydown', onKey, true);
    wide.addEventListener('change', onWide);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      wide.removeEventListener('change', onWide);
      opener?.focus();
    };
  }, [open]);

  return (
    <>
      {open && <div aria-hidden className="fixed inset-0 z-40 bg-canvas/60 lg:hidden" onClick={onClose} />}
      <Tag
        ref={panelRef as React.Ref<HTMLDivElement>}
        role={open ? 'dialog' : undefined}
        aria-modal={open || undefined}
        aria-label={open ? label : undefined}
        className={clsx(
          className,
          'max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:w-[min(20rem,88vw)] max-lg:overflow-y-auto max-lg:border-l max-lg:border-border max-lg:bg-canvas max-lg:shadow-2xl max-lg:transition-[translate,visibility] max-lg:duration-200',
          // visibility:hidden takes a closed drawer out of Tab order and the a11y tree.
          !open && 'max-lg:invisible max-lg:translate-x-full',
        )}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-canvas px-4 py-3 lg:hidden">
          <h2 className="text-sm font-semibold text-fg">{label}</h2>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label={`Close ${label}`}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </Tag>
    </>
  );
}
