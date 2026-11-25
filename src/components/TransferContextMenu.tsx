import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { ipc } from "../lib/ipc";
import { useT } from "../lib/i18n";
import { useClampedMenuPosition } from "../lib/contextMenu";
import { transferMenuActions } from "../lib/transferMenu";
import { toast } from "../store/feedback";
import type { TransferTask } from "../types";

export interface TransferMenuState {
  x: number;
  y: number;
  task: TransferTask;
}

export function TransferContextMenu({
  menu,
  onClose,
}: {
  menu: TransferMenuState | null;
  onClose: () => void;
}) {
  const tr = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const position = useClampedMenuPosition(menu, menuRef);

  useEffect(() => {
    if (!menu) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>("button:not([disabled])")
        ?.focus();
    });
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu, onClose]);

  if (!menu || !position) return null;
  const actions = transferMenuActions(menu.task);
  if (actions.length === 0) return null;

  const revealLocal = async () => {
    onClose();
    try {
      await ipc.localRevealPath(menu.task.localPath);
    } catch (e) {
      toast.error(String(e), tr("panel.openFolderFailed"));
    }
  };

  const copyRemotePath = async () => {
    onClose();
    try {
      await navigator.clipboard.writeText(menu.task.remotePath);
      toast.success(tr("transfer.remotePathCopied"));
    } catch {
      toast.error(tr("common.copyFailed"));
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
    >
      {actions.includes("revealLocal") && (
        <button
          type="button"
          className="ctx-menu__item"
          title={tr("transfer.revealLocal")}
          onClick={() => void revealLocal()}
        >
          <Icon name="folder" size={12} />
          {tr("transfer.revealLocal")}
        </button>
      )}
      {actions.includes("copyRemotePath") && (
        <button
          type="button"
          className="ctx-menu__item"
          title={tr("transfer.copyRemotePath")}
          onClick={() => void copyRemotePath()}
        >
          <Icon name="copy" size={12} />
          {tr("transfer.copyRemotePath")}
        </button>
      )}
    </div>,
    document.body
  );
}
