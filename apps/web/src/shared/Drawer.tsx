import { useEffect, useRef, type ReactNode } from "react";

export function Drawer({
  title,
  busy = false,
  onClose,
  children,
  returnFocus,
}: {
  title: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  returnFocus: HTMLElement | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = returnFocus;
    const element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      element.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="drawer"
      aria-labelledby="drawer-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="drawer-heading">
        <h2 id="drawer-title">{title}</h2>
        <button className="quiet" disabled={busy} onClick={onClose} aria-label="입력 닫기">
          닫기 ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
