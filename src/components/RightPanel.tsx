import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import {
  TransferContextMenu,
  type TransferMenuState,
} from "./TransferContextMenu";
import { useApp } from "../store/app";
import { useMonitor, selectMonitorConnection, computeUptimeSec } from "../store/monitor";
import { ipc } from "../lib/ipc";
import { resBarColor, resTextColor } from "../lib/resColor";
import { formatBytePair, formatBytes } from "../lib/formatBytes";
import { toast } from "../store/feedback";
import { useT } from "../lib/i18n";
import { loadSettings, saveSettings } from "../lib/settings";
import {
  isTransferActive,
  isTransferTerminal,
  transferEtaSeconds,
  transferLocation,
  transferPercent,
} from "../lib/transfer";
import type { TransferTask } from "../types";

/** 系统运行时长 → 天小时分秒（如 1天23小时11分20秒） */
function formatUptime(sec: number, t: (k: string, v?: Record<string, number>) => string): string {
  if (!sec) return "-";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return t("panel.uptimeDays", { d, h, m, s });
  if (h > 0) return t("panel.uptimeHours", { h, m, s });
  if (m > 0) return t("panel.uptimeMins", { m, s });
  return t("panel.uptimeSecs", { s });
}

/** CPU 使用率迷你曲线 → SVG polyline 坐标（0-100 归一化） */
function sparkline(points: number[], width = 100, height = 32): string {
  if (points.length < 2) return "";
  const max = Math.max(...points, 100);
  return points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - (Math.min(v, max) / max) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function taskStatusText(task: TransferTask, tr: (k: string) => string): string {
  switch (task.status) {
    case "completed":
      return tr("panel.task.done");
    case "failed":
      return tr("panel.task.failed");
    case "cancelled":
      return tr("panel.task.cancelled");
    case "paused":
      return tr("panel.task.paused");
    case "interrupted":
      return tr("panel.task.interrupted");
    case "running":
      return formatBytes(task.speed) + "/s";
    default:
      return tr("panel.task.queued");
  }
}

function TaskFillClass(t: TransferTask): string {
  if (t.status === "completed") return "res-bar__fill--success";
  if (t.status === "failed") return "res-bar__fill--error";
  if (t.status === "interrupted" || t.status === "paused") return "res-bar__fill--warning";
  return "res-bar__fill--brand";
}

function formatEta(seconds: number): string {
  const total = Math.max(1, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function RightPanel({ transfersOnly = false }: { transfersOnly?: boolean }) {
  const tr = useT();
  const transfers = useApp((s) => s.transfers);
  const sftpContext = useApp((s) => s.sftpContext);
  const appPaths = useApp((s) => s.appPaths);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const expanded = useApp((s) => s.rightPanelExpanded);
  const setExpanded = useApp((s) => s.setRightPanelExpanded);
  const initialLayoutLoaded = useRef(false);

  useEffect(() => {
    const layout = loadSettings();
    setExpanded(layout.rightPanelExpanded);
    useApp.setState({ sftpCollapsed: layout.sftpCollapsed });
    useApp.setState({ broadcastInput: layout.broadcastInput ?? false });
    initialLayoutLoaded.current = true;
  }, [setExpanded]);

  const changeExpanded = (next: boolean) => {
    setExpanded(next);
    saveSettings({ ...loadSettings(), rightPanelExpanded: next });
  };
  const doneTimers = useRef(new Set<string>());
  const [pendingTransfers, setPendingTransfers] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<TransferMenuState | null>(null);
  useEffect(() => {
    if (menu && !transfers.some((task) => task.id === menu.task.id)) {
      setMenu(null);
    }
  }, [menu, transfers]);
  // 传输重试节流：失败任务连点「重试」会重复创建传输任务，600ms 窗口内只允许一次
  const lastRetryAt = useRef(0);

  const patchTransferStatus = (taskId: string, status: TransferTask["status"]) => {
    useApp.setState((state) => ({
      transfers: state.transfers.map((task) =>
        task.id === taskId ? { ...task, status } : task
      ),
    }));
  };

  const mutateTransferStatus = async (
    task: TransferTask,
    nextStatus: TransferTask["status"],
    action: () => Promise<void>
  ) => {
    const previous = task.status;
    setPendingTransfers((current) => ({ ...current, [task.id]: true }));
    patchTransferStatus(task.id, nextStatus);
    try {
      await action();
    } catch (e) {
      patchTransferStatus(task.id, previous);
      toast.error(String(e), tr("panel.taskFailed"));
    } finally {
      setPendingTransfers((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
    }
  };

  /** 找到该传输所属会话当前可用的连接（重连后 connectionId 会变化） */
  const connectionForTask = (task: TransferTask): string | undefined =>
    tabs.find(
      (tab) =>
        tab.sessionId === task.sessionId &&
        tab.status === "connected" &&
        !!tab.connectionId
    )?.connectionId;

  const openTransferLocation = async (task: TransferTask) => {
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

  // ---- 指标数据统一来自共享监控数据源（与「监控」模块同一份，单一轮询） ----
  const metrics = useMonitor((s) => s.metrics);
  const netSpeed = useMonitor((s) => s.netSpeed);
  const cpuMeta = useMonitor((s) => s.cpuMeta);
  const cpuHist = useMonitor((s) => s.cpuHist);
  const lastSampleAt = useMonitor((s) => s.lastSampleAt);
  const uptimeBase = useMonitor((s) => s.uptimeBase);
  const nowTs = useMonitor((s) => s.nowTs);

  const connectionId = selectMonitorConnection(sftpContext, tabs, activeTabId);
  const connected = !!connectionId;

  // 已完成/失败/取消的传输任务保留 5 秒后自动移出队列；
  // 暂停/连接中断的任务必须保留，否则用户没有机会恢复。
  useEffect(() => {
    const done = transfers.filter(
      (t) =>
        isTransferTerminal(t) &&
        !pendingTransfers[t.id] &&
        !doneTimers.current.has(t.id)
    );
    done.forEach((t) => {
      doneTimers.current.add(t.id);
      setTimeout(() => {
        doneTimers.current.delete(t.id);
        useApp.setState((s) => ({ transfers: s.transfers.filter((x) => x.id !== t.id) }));
      }, 5000);
    });
  }, [transfers, pendingTransfers]);

  const retryTransfer = (t: TransferTask) => {
    const now = Date.now();
    if (now - lastRetryAt.current < 600) return;
    lastRetryAt.current = now;
    const conn = tabs.find(
      (x) => x.sessionId === t.sessionId && x.connectionId
    );
    if (!conn?.connectionId) {
      toast.warning(tr("panel.sessionGone"));
      return;
    }
    console.log("[transfer] retry", t.id, t.direction, { local: t.localPath, remote: t.remotePath });
    if (t.direction === "upload") {
      if (t.isDir) {
        void ipc.sftpUploadDir(conn.connectionId, t.sessionId, t.localPath, t.remotePath);
      } else {
        void ipc.sftpUpload(conn.connectionId, t.sessionId, t.localPath, t.remotePath);
      }
    } else {
      if (t.isDir) {
        void ipc.sftpDownloadDir(conn.connectionId, t.sessionId, t.remotePath, t.localPath);
      } else {
        void ipc.sftpDownload(conn.connectionId, t.sessionId, t.remotePath, t.localPath);
      }
    }
  };

  const cpu = metrics ? Math.round(metrics.cpu) : 0;
  const memPct = metrics && metrics.memTotal > 0 ? Math.round((metrics.memUsed / metrics.memTotal) * 100) : 0;
  const disk = metrics ? Math.round(metrics.diskUsedPct) : 0;
  // 磁盘详情优先取根分区，其次第一个分区
  const rootDisk =
    metrics?.disks.find((d) => d.mount === "/") ?? metrics?.disks[0];
  // 运行时长：共享数据源统一计算（本地时钟每秒补偿，不受监控刷新间隔影响）
  const uptimeSec = computeUptimeSec(metrics, uptimeBase, lastSampleAt, nowTs);

  if (!expanded) return null;

  return (
    <aside
      className={
        "right-panel is-expanded" +
        (transfersOnly ? " right-panel--transfers-only" : "")
      }
      aria-label={transfersOnly ? tr("panel.resourcesTransfers") : tr("panel.resources")}
    >
      {expanded && (
        <>
      <div className="right-panel__header">
        <span>{transfersOnly ? tr("panel.resourcesTransfers") : tr("panel.resources")}</span>
        <button
          className="ds-btn ds-btn--tertiary ds-btn--icon"
          type="button"
          title={transfersOnly ? tr("panel.collapseTransfers") : tr("panel.collapseMonitor")}
          aria-label={transfersOnly ? tr("panel.collapseTransfers") : tr("panel.collapseMonitor")}
          onClick={() => changeExpanded(false)}
        >
          <Icon name={transfersOnly ? "x" : "chevron-right"} size={15} />
        </button>
      </div>
      <div className="right-panel__body">
        {!connected ? (
          <div className="right-panel__empty right-panel__empty--full">
            <span className="right-panel__empty-icon">
              <Icon name="plug" size={26} />
            </span>
            <span className="right-panel__empty-text">{tr("panel.noServer")}</span>
            <span className="right-panel__empty-sub">
              {tr("panel.noServerSub")}
            </span>
          </div>
        ) : (
          <>
        <div className="right-panel__monitor">
        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="cpu" size={14} />CPU
            </span>
            <span className="res-card__value" style={{ color: resTextColor(cpu) }}>
              {cpu}%
            </span>
          </div>
          {cpuHist.length > 1 && (
            <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="res-spark">
              <polyline
                points={sparkline(cpuHist, 100, 32)}
                fill="none"
                stroke="var(--bg-brand)"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <div className="res-card__detail">
            {cpuMeta
              ? `${cpuMeta.cores ? tr("stats.cores", { n: cpuMeta.cores }) : "-"}${cpuMeta.freq ? " · " + cpuMeta.freq : ""}`
              : "--"}
          </div>
        </div>
        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="bar" size={14} />Memory
            </span>
            <span className="res-card__value" style={{ color: resTextColor(memPct) }}>
              {memPct}%
            </span>
          </div>
          <div className="res-bar">
            <div
              className={"res-bar__fill " + resBarColor(memPct)}
              style={{ width: Math.min(memPct, 100) + "%" }}
            />
          </div>
          <div className="res-card__detail">
            {metrics
              ? `${formatBytePair(metrics.memUsed, metrics.memTotal)}（${memPct}%）`
              : "--"}
          </div>
        </div>
        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="folder" size={14} />Disk
            </span>
            <span className="res-card__value" style={{ color: resTextColor(disk) }}>
              {disk}%
            </span>
          </div>
          <div className="res-bar">
            <div
              className={"res-bar__fill " + resBarColor(disk)}
              style={{ width: Math.min(disk, 100) + "%" }}
            />
          </div>
          <div className="res-card__detail">
            {metrics
              ? `${formatBytePair(rootDisk?.used ?? 0, rootDisk?.total ?? 0)}（${disk}%）`
              : "--"}
          </div>
        </div>

        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="clock" size={14} />{tr("panel.running")}
            </span>
            <span className="res-card__value res-card__value--uptime">
              {formatUptime(uptimeSec, tr)}
            </span>
          </div>
          <div className="res-card__detail">
            {metrics ? tr("panel.uptimeContinuous") : "--"}
          </div>
        </div>

        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="bar" size={14} />{tr("panel.load")}
            </span>
          </div>
          <div className="load-grid">
            <div className="load-cell">
              <span className="load-cell__label">{tr("panel.min1")}</span>
              <span className="load-cell__value">
                {metrics ? metrics.load1.toFixed(2) : "--"}
              </span>
            </div>
            <div className="load-cell">
              <span className="load-cell__label">{tr("panel.min5")}</span>
              <span className="load-cell__value">
                {metrics ? metrics.load5.toFixed(2) : "--"}
              </span>
            </div>
            <div className="load-cell">
              <span className="load-cell__label">{tr("panel.min15")}</span>
              <span className="load-cell__value">
                {metrics ? metrics.load15.toFixed(2) : "--"}
              </span>
            </div>
          </div>
        </div>

        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="arrow-right-to-line" size={14} />
              Network
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="net-row">
              <span className="net-row__label">{tr("mon.up")}</span>
              <span className="net-row__value">{formatBytes(netSpeed.tx)}/s</span>
            </div>
            <div className="net-row">
              <span className="net-row__label">{tr("mon.down")}</span>
              <span className="net-row__value">{formatBytes(netSpeed.rx)}/s</span>
            </div>
            <div className="net-row">
              <span className="net-row__label">{tr("mon.conns")}</span>
              <span className="net-row__value">{metrics?.netConns ?? 0}</span>
            </div>
          </div>
        </div>
        </div>

        <div className="right-panel__transfers">
          <div className="right-panel__section-title">{tr("panel.queue")}</div>
          {appPaths?.downloadDir && (
            <div className="transfer-pane__location">
              <Icon name="folder" size={13} />
              <span className="transfer-pane__location-label">{tr("panel.localDir")}</span>
              <span className="transfer-pane__location-path" title={appPaths.downloadDir}>
                {appPaths.downloadDir}
              </span>
              <button
                className="ds-btn ds-btn--tertiary ds-btn--icon"
                type="button"
                title={tr("panel.openFolder")}
                style={{ width: 20, height: 20, flexShrink: 0 }}
                onClick={() => {
                  void ipc
                    .localOpenPath(appPaths.downloadDir)
                    .catch((e) => toast.error(String(e), tr("panel.openFolderFailed")));
                }}
              >
                <Icon name="folder" size={12} />
              </button>
            </div>
          )}
          <div className="ds-card transfer-pane__list">
          {transfers.length === 0 && (
            <div className="transfer-row__status">{tr("panel.noTasks")}</div>
          )}
          {transfers.map((t) => {
            const pct = transferPercent(t);
            const eta = transferEtaSeconds(t);
            const location = transferLocation(t);
            const canPauseResume =
              (t.status === "running" ||
                t.status === "paused" ||
                t.status === "interrupted") &&
              !t.isDir;
            return (
              <div
                className="transfer-row"
                key={t.id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, task: t });
                }}
              >
                <div className="transfer-row__head">
                  <span
                    className="transfer-row__name"
                    title={t.direction === "download" ? t.localPath : t.remotePath}
                  >
                    <Icon name={t.direction === "upload" ? "upload" : "download"} size={13} />
                    {t.fileName}
                  </span>
                  <span className="transfer-row__status">
                    {taskStatusText(t, tr)}
                    {t.status === "failed" && (
                      <button
                        className="ds-btn ds-btn--secondary"
                        type="button"
                        title={tr("panel.retry")}
                        style={{ height: 18, marginLeft: 2, padding: "0 6px" }}
                        onClick={() => retryTransfer(t)}
                      >
                        {tr("panel.retry")}
                      </button>
                    )}
                    {/* 目录传输不支持断点续传，不提供暂停/恢复 */}
                    {canPauseResume && (
                      <button
                        className={
                          "ds-btn ds-btn--icon" +
                          (t.status === "running"
                            ? " ds-btn--tertiary"
                            : " ds-btn--secondary")
                        }
                        type="button"
                        disabled={!!pendingTransfers[t.id]}
                        title={
                          t.status === "running"
                            ? tr("panel.pauseTitle")
                            : tr("panel.resumeTitle")
                        }
                        style={{ width: 18, height: 18, marginLeft: 2 }}
                        onClick={() => {
                          if (t.status === "running") {
                            void mutateTransferStatus(t, "paused", () =>
                              ipc.transferPause(t.id)
                            );
                          } else {
                            const connId = connectionForTask(t);
                            if (!connId) {
                              toast.warning(tr("panel.sessionGone"));
                              return;
                            }
                            void mutateTransferStatus(t, "running", () =>
                              ipc.transferResume(t.id, connId)
                            );
                          }
                        }}
                      >
                        <Icon name={t.status === "running" ? "pause" : "play"} size={12} />
                      </button>
                    )}
                    {isTransferActive(t) && (
                      <button
                        className="ds-btn ds-btn--tertiary ds-btn--icon"
                        type="button"
                        disabled={!!pendingTransfers[t.id]}
                        title={tr("common.cancel")}
                        style={{ width: 18, height: 18, marginLeft: 2 }}
                        onClick={() => {
                          void mutateTransferStatus(t, "cancelled", () =>
                            ipc.transferCancel(t.id)
                          );
                        }}
                      >
                        <Icon name="x-circle" size={12} />
                      </button>
                    )}
                  </span>
                </div>
                <div className="transfer-row__meta">
                  {location ? (
                    <button
                      className="transfer-row__location"
                      type="button"
                      title={tr("panel.locate")}
                      onClick={() => void openTransferLocation(t)}
                    >
                      <Icon name="folder" size={11} />
                      <span>{location}</span>
                    </button>
                  ) : (
                    <span />
                  )}
                  {(t.totalBytes ?? 0) > 0 && (
                    <span className="transfer-row__size">
                      {formatBytes(t.transferredBytes ?? 0)} / {formatBytes(t.totalBytes ?? 0)}
                    </span>
                  )}
                </div>
                <div className="res-bar">
                  <div
                    className={"res-bar__fill " + TaskFillClass(t)}
                    style={{ width: pct + "%" }}
                  />
                </div>
                <div className="transfer-row__foot">
                  <span className="transfer-row__pct">{Math.floor(pct)}%</span>
                  {eta !== null && (
                    <span>{tr("panel.eta", { t: formatEta(eta) })}</span>
                  )}
                  {t.status === "interrupted" && (
                    <span className="transfer-row__warn">{tr("panel.reconnectHint")}</span>
                  )}
                </div>
              </div>
            );
          })}
          {transfers.length > 0 && (
            <div className="transfer-pane__hint">
              {tr("panel.hint")}
            </div>
          )}
          </div>
        </div>
          </>
        )}
      </div>
      <TransferContextMenu menu={menu} onClose={() => setMenu(null)} />
        </>
      )}
    </aside>
  );
}
