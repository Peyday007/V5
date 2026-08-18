/**
 * A minimal modal.
 *
 * Import and reconcile are the two places where the platform asks the user to
 * make a decision, and both must be dismissible without losing the underlying
 * screen — so this overlays rather than navigates, and never unmounts the panes
 * behind it.
 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';

export function Modal(props: {
  title: string;
  open: boolean;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element | null {
  const { open, onClose } = props;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal__overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="modal__header spread">
          <h2 className="modal__title">{props.title}</h2>
          <button type="button" className="btn btn--ghost modal__close" onClick={onClose}>
            CLOSE
          </button>
        </div>
        <div className="modal__body">{props.children}</div>
        {props.footer ? <div className="modal__footer spread">{props.footer}</div> : null}
      </div>
    </div>
  );
}
