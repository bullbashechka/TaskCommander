import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export function Modal({
  open,
  onClose,
  title,
  description,
  className = '',
  children,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  className?: string;
  children: ReactNode;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelector<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href]',
    );
    if (focusable) focusable.focus();
    else dialog?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href]',
        ),
      ];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
      else returnFocusRef?.current?.focus();
    };
  }, [onClose, open, returnFocusRef]);

  if (!open) return null;
  return createPortal(
    <>
      <button
        aria-label="Закрыть диалог"
        className="dialog-backdrop"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <div className="dialog-viewport">
        <div
          aria-describedby={descriptionId}
          aria-labelledby={titleId}
          aria-modal="true"
          className={`dialog-card ${className}`.trim()}
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <h2 className="dialog-title" id={titleId}>
            {title}
          </h2>
          <p className="dialog-description" id={descriptionId}>
            {description}
          </p>
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}
