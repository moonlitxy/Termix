import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import { formatBytes } from "../lib/formatBytes";
import { confirmDialog, toast } from "../store/feedback";
import { useT } from "../lib/i18n";
import { loadSettings, saveSettings } from "../lib/settings";
import {
  TransferContextMenu,
  type TransferMenuState,
} from "./TransferContextMenu";
import {
  formatEta,
  isTransferActive,
  transferEtaSeconds,
  transferLocation,
  transferPercent,
} from "../lib/transfer";
import type { TransferTask } from "../types";

interface FloatLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

type DragMode = "move" | "resize";

const LAYOUT_KEY = "termix.transferWindowLayout";
const DEFAULT_WIDTH = 430;
const DEFAULT_HEIGHT = 300;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 250;
const EDGE = 12;
const GAP = 28;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function loadLayout(): FloatLayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<FloatLayout>;
    const nums = [value.x, value.y, value.width, value.height];
    if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return null;
    }
    return {
      x: value.x!,
      y: value.y!,
      width: value.width!,
      height: value.height!,
    };
  } catch {
    return null;
  }
}

function saveLayout(layout: FloatLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* ignore quota/private mode */
  }
}

function statusText(task: TransferTask, tr: (key: string) => string): string {
  const pct = Math.floor(transferPercent(task));
  switch (task.status) {
    case "running":
      return task.speed > 0
        ? `${pct}% · ${formatBytes(task.speed)}/s`
        : `${pct}%`;
    case "paused":
      return tr("panel.task.paused");
    case "interrupted":
      return tr("panel.task.interrupted");
    case "completed":
      return tr("panel.task.done");
    case "failed":
      return tr("panel.task.failed");
    case "cancelled":
      return tr("panel.task.cancelled");
    default:
      return tr("panel.task.queued");
  }
}

function barColor(task: TransferTask): string {
  if (task.status === "completed") return "var(--status-success-default)";
  if (task.status === "failed" || task.status === "cancelled") {
    return "var(--status-error-default)";
  }
  if (task.status === "paused" || task.status === "interrupted") {
    return "var(--status-warning-default)";
  }
  return "var(--bg-brand)";
}

export function TransferWindow() {
  const tr = useT();
  const transfers = useApp((s) => s.transfers);
  const open = useApp((s) => s.transferWindowOpen);
  const setOpen = useApp((s) => s.setTransferWindowOpen);
  const tabs = useApp((s) => s.tabs);
  const appPaths = useApp((s) => s.appPaths);
  const localPath = useApp((s) => s.localPath);

  const [layout, setLayout] = useState<FloatLayout | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [clearing, setClearing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<TransferMenuState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<FloatLayout | null>(null);
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    start: FloatLayout;
  } | null>(null);
  const lastRetryRef = useRef(0);

  const activeCount = transfers.filter(isTransferActive).length;
  const downloadDir = appPaths?.downloadDir || localPath;

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    if (!open) setMenu(null);
  }, [open]);

  useEffect(() => {
    if (menu && !transfers.some((task) => task.id === menu.task.id)) {
      setMenu(null);
    }
  }, [menu, transfers]);

  // 打开时恢复上次位置/大小，并按当前工作区尺寸夹紧
  useEffect(() => {
    if (!open) return;
    const parent = rootRef.current?.offsetParent as HTMLElement | null;
    if (!parent) return;
    const saved = loadLayout();
    const width = clamp(
      saved?.width ?? DEFAULT_WIDTH,
      MIN_WIDTH,
      parent.clientWidth - EDGE * 2
    );
    const height = clamp(
      saved?.height ?? DEFAULT_HEIGHT,
      MIN_HEIGHT,
      parent.clientHeight - EDGE * 2
    );
    const x = clamp(
      saved?.x ?? parent.clientWidth - width - GAP,
      EDGE,
      parent.clientWidth - width - EDGE
    );
    const y = clamp(
      saved?.y ?? 96,
      EDGE,
      parent.clientHeight - height - EDGE
    );
    setLayout({ x, y, width, height });
  }, [open]);

  // 窗口尺寸变化时保持悬浮窗在工作区内
  useEffect(() => {
    if (!open) return;
    const parent = rootRef.current?.offsetParent as HTMLElement | null;
    if (!parent) return;
    const observer = new ResizeObserver(() => {
      setLayout((previous) => {
        if (!previous) return previous;
        const width = clamp(
          previous.width,
          MIN_WIDTH,
          parent.clientWidth - EDGE * 2
        );
        const height = clamp(
          previous.height,
          MIN_HEIGHT,
          parent.clientHeight - EDGE * 2
        );
        return {
          width,
          height,
          x: clamp(previous.x, EDGE, parent.clientWidth - width - EDGE),
          y: clamp(previous.y, EDGE, parent.clientHeight - height - EDGE),
        };
      });
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [open]);

  const openWindow = () => {
    setOpen(true);
    saveSettings({ ...loadSettings(), transferWindowOpen: true });
  };

  const closeWindow = () => {
    setOpen(false);
    saveSettings({ ...loadSettings(), transferWindowOpen: false });
  };

  const patchStatus = (taskId: string, status: TransferTask["status"]) => {
    useApp.setState((state) => ({
      transfers: state.transfers.map((task) =>
        task.id === taskId ? { ...task, status } : task
      ),
    }));
  };

  const connectionForTask = (task: TransferTask): string | undefined =>
    tabs.find(
      (tab) =>
        tab.sessionId === task.sessionId &&
        tab.status === "connected" &&
        !!tab.connectionId
    )?.connectionId;

  const openLocation = async (task: TransferTask) => {
    const location = transferLocation(task);
    if (!location) return;
    if (task.direction === "download") {
      void ipc
        .localOpenPath(location)
        .catch((e) => toast.error(String(e), tr("panel.openFolderFailed")));
      return;
    }
    const tab = tabs.find(
      (candidate) =>
        candidate.sessionId === task.sessionId &&
        !candidate.hidden &&
        candidate.status === "connected" &&
        !!candidate.connectionId
    );
    if (!tab?.connectionId) {
      toast.warning(tr("panel.sessionGone"));
      return;
    }
    const st = useApp.getState();
    if (st.sftpContext?.connectionId !== tab.connectionId) {
      await st.setSftpContext(task.sessionId, tab.connectionId);
    }
    useApp.setState({
      activeTabId: tab.id,
      activity: "sftp",
      remotePath: location,
    });
    void useApp.getState().loadRemote();
  };

  const togglePause = async (task: TransferTask) => {
    const previous = task.status;
    if (task.status !== "running" && !connectionForTask(task)) {
      toast.warning(tr("panel.sessionGone"));
      return;
    }
    setPending((current) => ({ ...current, [task.id]: true }));
    try {
      if (task.status === "running") {
        patchStatus(task.id, "paused");
        await ipc.transferPause(task.id);
      } else {
        const connectionId = connectionForTask(task);
        if (!connectionId) throw new Error(tr("panel.sessionGone"));
        patchStatus(task.id, "running");
        await ipc.transferResume(task.id, connectionId);
      }
    } catch (e) {
      patchStatus(task.id, previous);
      toast.error(String(e), tr("panel.taskFailed"));
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
    }
  };

  const retryTask = (task: TransferTask) => {
    const now = Date.now();
    if (now - lastRetryRef.current < 600) return;
    lastRetryRef.current = now;
    const connectionId = connectionForTask(task);
    if (!connectionId) {
      toast.warning(tr("panel.sessionGone"));
      return;
    }
    const fail = (e: unknown) =>
      toast.error(String(e), tr("panel.taskFailed"));
    if (task.direction === "upload") {
      const action = task.isDir
        ? ipc.sftpUploadDir(connectionId, task.sessionId, task.localPath, task.remotePath)
        : ipc.sftpUpload(connectionId, task.sessionId, task.localPath, task.remotePath);
      void action.catch(fail);
    } else {
      const action = task.isDir
        ? ipc.sftpDownloadDir(connectionId, task.sessionId, task.remotePath, task.localPath)
        : ipc.sftpDownload(connectionId, task.sessionId, task.remotePath, task.localPath);
      void action.catch(fail);
    }
  };

  const deleteTask = async (task: TransferTask) => {
    if (isTransferActive(task)) {
      const confirmed = await confirmDialog({
        title: tr("transfer.deleteTitle"),
        message: tr("transfer.deleteConfirm"),
        confirmText: tr("common.delete"),
        danger: true,
      });
      if (!confirmed) return;
    }
    setPending((current) => ({ ...current, [task.id]: true }));
    try {
      await ipc.transferDelete(task.id);
      useApp.setState((state) => ({
        transfers: state.transfers.filter((item) => item.id !== task.id),
      }));
    } catch (e) {
      toast.error(String(e), tr("panel.taskFailed"));
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
    }
  };

  const clearQueue = async () => {
    if (transfers.length === 0 || clearing) return;
    if (activeCount > 0) {
      const confirmed = await confirmDialog({
        title: tr("transfer.clearTitle"),
        message: tr("transfer.clearConfirm", { n: activeCount }),
        confirmText: tr("transfer.clear"),
        danger: true,
      });
      if (!confirmed) return;
    }
    setClearing(true);
    try {
      await ipc.transferClear();
      useApp.setState({ transfers: [] });
      toast.success(tr("transfer.cleared"));
    } catch (e) {
      toast.error(String(e), tr("panel.taskFailed"));
    } finally {
      setClearing(false);
    }
  };

  const parentElement = () =>
    rootRef.current?.offsetParent as HTMLElement | null;

  const beginDrag = (e: React.PointerEvent, mode: DragMode) => {
    if (e.button !== 0) return;
    if (mode === "move" && (e.target as HTMLElement).closest("button")) return;
    const parent = parentElement();
    if (!parent || !layout) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      start: layout,
    };
    setDragging(true);
  };

  const moveDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const parent = parentElement();
    if (!drag || !parent) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (drag.mode === "move") {
      const next = {
        ...drag.start,
        x: clamp(
          drag.start.x + dx,
          EDGE,
          parent.clientWidth - drag.start.width - EDGE
        ),
        y: clamp(
          drag.start.y + dy,
          EDGE,
          parent.clientHeight - drag.start.height - EDGE
        ),
      };
      layoutRef.current = next;
      setLayout(next);
    } else {
      const next = {
        ...drag.start,
        width: clamp(
          drag.start.width + dx,
          MIN_WIDTH,
          parent.clientWidth - drag.start.x - EDGE
        ),
        height: clamp(
          drag.start.height + dy,
          MIN_HEIGHT,
          parent.clientHeight - drag.start.y - EDGE
        ),
      };
      layoutRef.current = next;
      setLayout(next);
    }
  };

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (layoutRef.current) saveLayout(layoutRef.current);
  };

  if (!open) {
    if (transfers.length === 0) return null;
    return (
      <button
        className="tf-pill"
        type="button"
        title={tr("transfer.open")}
        onClick={openWindow}
      >
        <Icon name="download" size={14} />
        <span>{tr("transfer.pill")}</span>
        {activeCount > 0 && <span className="tf-pill__count">{activeCount}</span>}
      </button>
    );
  }

  const windowStyle: React.CSSProperties = layout
    ? {
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
      }
    : {
        right: GAP,
        top: 96,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
      };

  return (
    <div
      ref={rootRef}
      className={"tf-window" + (dragging ? " is-dragging" : "")}
      style={windowStyle}
      role="dialog"
      aria-modal="false"
      aria-label={tr("transfer.title")}
    >
      <div
        className="tf-head"
        onPointerDown={(e) => beginDrag(e, "move")}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <span className="tf-grip" />
        <Icon name="download" size={12} />
        <span className="tf-title">{tr("transfer.title")}</span>
        {activeCount > 0 && <span className="tf-count">{activeCount}</span>}
        <span className="tf-actions">
          <button
            className="tf-btn"
            type="button"
            title={tr("transfer.clearTitle")}
            disabled={transfers.length === 0 || clearing}
            onClick={() => void clearQueue()}
          >
            <Icon name="trash" size={12} />
          </button>
          <button
            className="tf-btn"
            type="button"
            title={tr("transfer.close")}
            onClick={closeWindow}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      </div>

      <div className="tf-path">
        <Icon name="folder" size={11} />
        <span className="tf-path__label">{tr("transfer.downloadTo")}</span>
        <span className="tf-path__value" title={downloadDir}>
          {downloadDir || tr("sftp.noDownloadDir")}
        </span>
        {downloadDir && (
          <button
            className="tf-btn"
            type="button"
            title={tr("transfer.openFolder")}
            onClick={() => {
              void ipc
                .localOpenPath(downloadDir)
                .catch((e) => toast.error(String(e), tr("panel.openFolderFailed")));
            }}
          >
            <Icon name="folder" size={10} />
          </button>
        )}
      </div>

      <div className="tf-list">
        {transfers.length === 0 && (
          <div className="tf-empty">{tr("panel.noTasks")}</div>
        )}
        {transfers.map((task) => {
          const pct = Math.floor(transferPercent(task));
          const location = transferLocation(task);
          const eta = transferEtaSeconds(task);
          const busy = !!pending[task.id];
          const canPause = isTransferActive(task) && !task.isDir;
          return (
            <div
              className="tf-row"
              key={task.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, task });
              }}
            >
              <div className="tf-row__head">
                <span
                  className="tf-row__name"
                  title={task.direction === "download" ? task.localPath : task.remotePath}
                >
                  <Icon
                    name={task.direction === "upload" ? "upload" : "download"}
                    size={11}
                  />
                  {task.fileName}
                </span>
                <span className="tf-row__status">{statusText(task, tr)}</span>
                {canPause && (
                  <button
                    className="tf-btn"
                    type="button"
                    disabled={busy}
                    title={
                      task.status === "running"
                        ? tr("panel.pauseTitle")
                        : tr("panel.resumeTitle")
                    }
                    onClick={() => void togglePause(task)}
                  >
                    <Icon
                      name={task.status === "running" ? "pause" : "play"}
                      size={10}
                    />
                  </button>
                )}
                {task.status === "failed" && (
                  <button
                    className="tf-btn"
                    type="button"
                    title={tr("panel.retry")}
                    onClick={() => retryTask(task)}
                  >
                    <Icon name="refresh" size={10} />
                  </button>
                )}
                <button
                  className="tf-btn"
                  type="button"
                  disabled={busy}
                  title={tr("transfer.delete")}
                  onClick={() => void deleteTask(task)}
                >
                  <Icon name="trash" size={10} />
                </button>
              </div>
              <div className="tf-row__bar">
                <span style={{ width: `${pct}%`, background: barColor(task) }} />
              </div>
              <div className="tf-row__meta">
                <button
                  className="tf-row__path"
                  type="button"
                  title={tr("panel.locate")}
                  disabled={!location}
                  onClick={() => void openLocation(task)}
                >
                  <Icon name="folder" size={9} />
                  <span>{location || "-"}</span>
                </button>
                <span className="tf-row__size">
                  {(task.totalBytes ?? 0) > 0
                    ? `${formatBytes(task.transferredBytes ?? 0)} / ${formatBytes(
                        task.totalBytes ?? 0
                      )}`
                    : ""}
                  {eta !== null ? ` · ${formatEta(eta)}` : ""}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="tf-foot">
        <span
          className={
            "ds-dot " + (activeCount > 0 ? "ds-dot--success" : "ds-dot--muted")
          }
        />
        {transfers.length === 0
          ? tr("panel.noTasks")
          : activeCount > 0
            ? tr("transfer.footer")
            : tr("transfer.footerIdle")}
      </div>

      <span
        className="tf-resize"
        onPointerDown={(e) => beginDrag(e, "resize")}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      <TransferContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
