import { useEffect, useRef } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { useMonitor, selectMonitorConnection, computeUptimeSec } from "../store/monitor";
import { ipc } from "../lib/ipc";
import { resBarColor, resTextColor } from "../lib/resColor";
import type { TransferTask } from "../types";

function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

/** 系统运行时长 → 天小时分秒（如 1天23小时11分20秒） */
function formatUptime(sec: number): string {
  if (!sec) return "-";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}天${h}小时${m}分${s}秒`;
  if (h > 0) return `${h}小时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
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

function taskStatusText(t: TransferTask): string {
  switch (t.status) {
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "paused":
      return "已暂停";
    case "running":
      return formatBytes(t.speed) + "/s";
    default:
      return "排队中";
  }
}

function TaskFillClass(t: TransferTask): string {
  if (t.status === "completed") return "res-bar__fill--success";
  if (t.status === "failed") return "res-bar__fill--error";
  return "res-bar__fill--brand";
}

export function RightPanel() {
  const transfers = useApp((s) => s.transfers);
  const sftpContext = useApp((s) => s.sftpContext);
  const tabs = useApp((s) => s.tabs);
  const doneTimers = useRef(new Set<string>());
  // 传输重试节流：失败任务连点「重试」会重复创建传输任务，600ms 窗口内只允许一次
  const lastRetryAt = useRef(0);

  // ---- 指标数据统一来自共享监控数据源（与「监控」模块同一份，单一轮询） ----
  const metrics = useMonitor((s) => s.metrics);
  const netSpeed = useMonitor((s) => s.netSpeed);
  const cpuMeta = useMonitor((s) => s.cpuMeta);
  const cpuHist = useMonitor((s) => s.cpuHist);
  const lastSampleAt = useMonitor((s) => s.lastSampleAt);
  const uptimeBase = useMonitor((s) => s.uptimeBase);
  const nowTs = useMonitor((s) => s.nowTs);

  const connectionId = selectMonitorConnection(sftpContext, tabs);
  const connected = !!connectionId;

  // 已完成/失败/取消的传输任务保留 5 秒后自动移出队列
  useEffect(() => {
    const done = transfers.filter(
      (t) => t.status !== "running" && !doneTimers.current.has(t.id)
    );
    done.forEach((t) => {
      doneTimers.current.add(t.id);
      setTimeout(() => {
        doneTimers.current.delete(t.id);
        useApp.setState((s) => ({ transfers: s.transfers.filter((x) => x.id !== t.id) }));
      }, 5000);
    });
  }, [transfers]);

  const retryTransfer = (t: TransferTask) => {
    const now = Date.now();
    if (now - lastRetryAt.current < 600) return;
    lastRetryAt.current = now;
    const conn = tabs.find(
      (x) => x.sessionId === t.sessionId && x.connectionId
    );
    if (!conn?.connectionId) {
      window.alert("该会话已断开，请先重新连接后再试");
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

  return (
    <div className="right-panel">
      <div className="right-panel__header">
        <span>资源监控</span>
        <button className="ds-btn ds-btn--tertiary ds-btn--icon" type="button" title="刷新">
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <div className="right-panel__body">
        {!connected ? (
          <div className="right-panel__empty right-panel__empty--full">
            <span className="right-panel__empty-icon">
              <Icon name="plug" size={26} />
            </span>
            <span className="right-panel__empty-text">未连接服务器</span>
            <span className="right-panel__empty-sub">
              打开终端连接会话后，在此查看实时资源占用与传输队列
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
              ? `${cpuMeta.cores ? cpuMeta.cores + " 核" : "-"}${cpuMeta.freq ? " · " + cpuMeta.freq : ""}`
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
              ? `${formatBytes(metrics.memUsed)} / ${formatBytes(metrics.memTotal)}`
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
              ? `${formatBytes(rootDisk?.used ?? 0)} / ${formatBytes(rootDisk?.total ?? 0)}`
              : "--"}
          </div>
        </div>

        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="clock" size={14} />运行
            </span>
            <span className="res-card__value res-card__value--uptime">
              {formatUptime(uptimeSec)}
            </span>
          </div>
          <div className="res-card__detail">
            {metrics ? "系统已连续运行时长" : "--"}
          </div>
        </div>

        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="bar" size={14} />负载
            </span>
          </div>
          <div className="load-grid">
            <div className="load-cell">
              <span className="load-cell__label">1 分钟</span>
              <span className="load-cell__value">
                {metrics ? metrics.load1.toFixed(2) : "--"}
              </span>
            </div>
            <div className="load-cell">
              <span className="load-cell__label">5 分钟</span>
              <span className="load-cell__value">
                {metrics ? metrics.load5.toFixed(2) : "--"}
              </span>
            </div>
            <div className="load-cell">
              <span className="load-cell__label">15 分钟</span>
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
              <span className="net-row__label">↑ 上行</span>
              <span className="net-row__value">{formatBytes(netSpeed.tx)}/s</span>
            </div>
            <div className="net-row">
              <span className="net-row__label">↓ 下行</span>
              <span className="net-row__value">{formatBytes(netSpeed.rx)}/s</span>
            </div>
            <div className="net-row">
              <span className="net-row__label">连接数</span>
              <span className="net-row__value">{metrics?.netConns ?? 0}</span>
            </div>
          </div>
        </div>
        </div>

        <div className="right-panel__transfers">
          <div className="right-panel__section-title">传输队列</div>
          <div className="ds-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {transfers.length === 0 && (
            <div className="transfer-row__status">暂无传输任务</div>
          )}
          {transfers.map((t) => (
            <div key={t.id}>
              <div className="transfer-row__head">
                <span className="transfer-row__name">
                  <Icon name={t.direction === "upload" ? "upload" : "download"} size={13} />
                  {t.fileName}
                </span>
                <span className="transfer-row__status">
                  {taskStatusText(t)}
                  {t.status === "failed" && (
                    <button
                      className="ds-btn ds-btn--secondary"
                      type="button"
                      title="重试"
                      style={{ height: 18, marginLeft: 2, padding: "0 6px" }}
                      onClick={() => retryTransfer(t)}
                    >
                      重试
                    </button>
                  )}
                  {/* 目录传输不支持断点续传，不提供暂停/恢复 */}
                  {(t.status === "running" || t.status === "paused") && !t.isDir && (
                    <button
                      className={
                        "ds-btn ds-btn--icon" +
                        (t.status === "paused"
                          ? " ds-btn--secondary"
                          : " ds-btn--tertiary")
                      }
                      type="button"
                      title={
                        t.status === "running"
                          ? "暂停：中断传输并保留已上传/下载的部分文件"
                          : "恢复：从断点继续传输"
                      }
                      style={{ width: 18, height: 18, marginLeft: 2 }}
                      onClick={() => {
                        if (t.status === "running") {
                          console.log("[transfer] pause task", t.id);
                          ipc
                            .transferPause(t.id)
                            .catch((e) => console.warn("[transfer] pause failed:", e));
                        } else {
                          console.log("[transfer] resume task", t.id);
                          ipc
                            .transferResume(t.id)
                            .catch((e) => console.warn("[transfer] resume failed:", e));
                        }
                      }}
                    >
                      <Icon name={t.status === "running" ? "pause" : "play"} size={12} />
                    </button>
                  )}
                  {(t.status === "running" || t.status === "paused") && (
                    <button
                      className="ds-btn ds-btn--tertiary ds-btn--icon"
                      type="button"
                      title="取消"
                      style={{ width: 18, height: 18, marginLeft: 2 }}
                      onClick={() => {
                        console.log("[transfer] cancel task", t.id);
                        ipc
                          .transferCancel(t.id)
                          .catch((e) => console.warn("[transfer] cancel failed:", e));
                      }}
                    >
                      <Icon name="x-circle" size={12} />
                    </button>
                  )}
                </span>
              </div>
              <div className="res-bar res-bar--thin">
                <div
                  className={"res-bar__fill " + TaskFillClass(t)}
                  style={{ width: Math.min(t.progress, 100) + "%" }}
                />
              </div>
            </div>
          ))}
          {transfers.length > 0 && (
            <div className="transfer-pane__hint">
              单个文件支持暂停/恢复（断点续传），目录传输仅支持取消
            </div>
          )}
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  );
}
