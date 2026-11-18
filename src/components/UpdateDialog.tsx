import { Icon } from "./Icon";
import { ipc } from "../lib/ipc";
import { useUpdate } from "../store/update";
import { loadSettings } from "../lib/settings";
import { describeUpdateEndpoint } from "../lib/updateSource";
import { useEffect, useRef } from "react";
import { useFocusTrap } from "../lib/focusTrap";
import { useT } from "../lib/i18n";

/** 软件更新提示弹窗：检测到新版本后弹出，用户可选择立即更新 / {t("update.later")} / {t("update.skip")} */
export function UpdateDialog() {
  const t = useT();
  const open = useUpdate((s) => s.dialogOpen);
  const info = useUpdate((s) => s.info);
  const downloading = useUpdate((s) => s.downloading);
  const progress = useUpdate((s) => s.progress);
  const downloadedPath = useUpdate((s) => s.downloadedPath);
  const error = useUpdate((s) => s.error);
  const closeDialog = useUpdate((s) => s.closeDialog);
  const download = useUpdate((s) => s.download);
  const skip = useUpdate((s) => s.skip);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open && !!info);

  useEffect(() => {
    if (!open || !info || downloading || downloadedPath) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeDialog();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [open, info, downloading, downloadedPath, closeDialog]);

  if (!open || !info) return null;
  const busy = downloading;

  return (
    <div
      className="dialog-overlay"
      onMouseDown={() => {
        // 下载进行中不允许点击背景关闭，避免用户看不到进度
        if (!busy) closeDialog();
      }}
    >
      <div
        className="dialog dialog--update"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("update.newVersion", { ver: info.latestVersion })}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog__header">
          <span className="dialog__title">
            <Icon name="download" size={15} />
            {t("update.newVersion", { ver: info.latestVersion })}
          </span>
          <button
            className="dialog__close"
            type="button"
            onClick={closeDialog}
            disabled={busy}
            title={t("common.close")}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="dialog__field upd-versions">
          <span className="upd-versions__old">{t("update.current", { ver: info.currentVersion })}</span>
          <span className="upd-versions__arrow">
            <Icon name="arrow-right-to-line" size={14} />
          </span>
          <span className="upd-versions__new">{t("update.newVersion", { ver: info.latestVersion })}</span>
        </div>

        <div className="dialog__field">
          <div className="dialog__field-label">{t("update.source")}</div>
          <div className="upd-notes">{describeUpdateEndpoint(loadSettings())}</div>
        </div>

        <div className="dialog__field">
          <div className="dialog__field-label">{t("update.notes")}</div>
          <div className="upd-notes">{info.releaseNotes || t("update.noNotes")}</div>
        </div>

        {error && <div className="dialog__field-error">{error}</div>}

        {downloading && (
          <div className="dialog__field">
            <div className="upd-progress">
              <div className="upd-progress__bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="upd-progress__text">{t("update.downloading", { p: progress })}</div>
          </div>
        )}

        {downloadedPath && (
          <div className="dialog__field">
            <div className="upd-done">{t("update.done")}</div>
          </div>
        )}

        <div className="dialog__actions">
          <button
            className="ds-btn ds-btn--secondary"
            type="button"
            disabled={busy}
            onClick={() => skip(info.latestVersion)}
            title={t("update.skipTitle")}
          >
            {t("update.skip")}
          </button>
          <button
            className="ds-btn ds-btn--secondary"
            type="button"
            disabled={busy}
            onClick={closeDialog}
            title={t("update.laterTitle")}
          >
            {t("update.later")}
          </button>
          {info.assetUrl ? (
            <button
              className="ds-btn ds-btn--brand"
              type="button"
              disabled={busy || !!downloadedPath}
              onClick={() => void download()}
              title={t("update.nowTitle")}
            >
              {downloading ? t("update.downloadingBtn") : t("update.now")}
            </button>
          ) : (
            <button
              className="ds-btn ds-btn--brand"
              type="button"
              onClick={() => void ipc.openExternal(info.releaseUrl).catch(() => {})}
              title={t("update.openRelease")}
            >
              {t("update.goRelease")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
