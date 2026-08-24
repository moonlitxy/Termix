import { Icon } from "./Icon";
import { ipc } from "../lib/ipc";
import { useUpdate } from "../store/update";

/** 软件更新提示弹窗：检测到新版本后弹出，用户可选择立即更新 / 稍后提醒 / 忽略此版本 */
export function UpdateDialog() {
  const open = useUpdate((s) => s.dialogOpen);
  const info = useUpdate((s) => s.info);
  const downloading = useUpdate((s) => s.downloading);
  const progress = useUpdate((s) => s.progress);
  const downloadedPath = useUpdate((s) => s.downloadedPath);
  const error = useUpdate((s) => s.error);
  const closeDialog = useUpdate((s) => s.closeDialog);
  const download = useUpdate((s) => s.download);
  const skip = useUpdate((s) => s.skip);

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
      <div className="dialog dialog--update" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog__header">
          <span className="dialog__title">
            <Icon name="download" size={15} />
            发现新版本 v{info.latestVersion}
          </span>
          <button
            className="dialog__close"
            type="button"
            onClick={closeDialog}
            disabled={busy}
            title="关闭"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="dialog__field upd-versions">
          <span className="upd-versions__old">当前版本 v{info.currentVersion}</span>
          <span className="upd-versions__arrow">
            <Icon name="arrow-right-to-line" size={14} />
          </span>
          <span className="upd-versions__new">最新版本 v{info.latestVersion}</span>
        </div>

        <div className="dialog__field">
          <div className="dialog__field-label">更新内容</div>
          <div className="upd-notes">{info.releaseNotes || "暂无更新说明"}</div>
        </div>

        {error && <div className="dialog__field-error">{error}</div>}

        {downloading && (
          <div className="dialog__field">
            <div className="upd-progress">
              <div className="upd-progress__bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="upd-progress__text">正在下载安装包… {progress}%</div>
          </div>
        )}

        {downloadedPath && (
          <div className="dialog__field">
            <div className="upd-done">下载完成，正在打开安装程序，请按提示完成安装。</div>
          </div>
        )}

        <div className="dialog__actions">
          <button
            className="ds-btn ds-btn--secondary"
            type="button"
            disabled={busy}
            onClick={() => skip(info.latestVersion)}
            title="本次更新不再提醒"
          >
            忽略此版本
          </button>
          <button
            className="ds-btn ds-btn--secondary"
            type="button"
            disabled={busy}
            onClick={closeDialog}
            title="稍后提醒，下次启动时再次检查"
          >
            稍后提醒
          </button>
          {info.assetUrl ? (
            <button
              className="ds-btn ds-btn--brand"
              type="button"
              disabled={busy || !!downloadedPath}
              onClick={() => void download()}
              title="下载并打开安装包"
            >
              {downloading ? "下载中…" : "立即更新"}
            </button>
          ) : (
            <button
              className="ds-btn ds-btn--brand"
              type="button"
              onClick={() => void ipc.openExternal(info.releaseUrl).catch(() => {})}
              title="使用浏览器打开 Release 下载页"
            >
              前往下载页
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
