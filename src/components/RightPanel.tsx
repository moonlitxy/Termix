import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import { loadSettings, SETTINGS_CHANGE_EVENT } from "../lib/settings";
import { resBarColor, resTextColor } from "../lib/resColor";
import type { Metrics, TransferTask } from "../types";

function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
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
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [netSpeed, setNetSpeed] = useState({ rx: 0, tx: 0 });
  const lastSample = useRef<Metrics | null>(null);
  const doneTimers = useRef(new Set<string>());

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

  const connectionId =
    sftpContext?.connectionId ??
    tabs.find((t) => t.status === "connected" && t.connectionId)?.connectionId ??
    null;

  useEffect(() => {
    if (!connectionId) {
      setMetrics(null);
      lastSample.current = null;
      return;
    }
    let stopped = false;
    let iv: number | undefined;
    // busy 防止并发轮询：monitor 命令执行时间可能长于轮询间隔，
    // 若并发请求会相互覆盖采样，导致网络速率计算出现天文数字
    let busy = false;
    let lastTs = 0;

    const startTimers = () => {
      clearInterval(iv);
      const interval = loadSettings().monitorInterval;
      const tick = async () => {
        if (busy) return;
        busy = true;
        const ts = Date.now();
        try {
          const m = await ipc.monitorMetrics(connectionId);
          if (stopped) return;
          if (lastSample.current && lastTs > 0) {
            const dt = (ts - lastTs) / 1000; // 实际采样间隔（秒）
            if (dt > 0) {
              setNetSpeed({
                rx: Math.max(0, m.netRx - lastSample.current.netRx) / dt,
                tx: Math.max(0, m.netTx - lastSample.current.netTx) / dt,
              });
            }
          }
          lastSample.current = m;
          lastTs = ts;
          setMetrics(m);
        } catch {
          /* ignore */
        } finally {
          busy = false;
        }
      };
      void tick();
      iv = setInterval(() => void tick(), interval);
    };

    startTimers();
    const onSettings = () => startTimers();
    window.addEventListener(SETTINGS_CHANGE_EVENT, onSettings);
    return () => {
      stopped = true;
      window.removeEventListener(SETTINGS_CHANGE_EVENT, onSettings);
      clearInterval(iv);
    };
  }, [connectionId]);

  const connected = !!connectionId;
  const cpu = metrics ? Math.round(metrics.cpu) : 0;
  const memPct = metrics && metrics.memTotal > 0 ? Math.round((metrics.memUsed / metrics.memTotal) * 100) : 0;
  const disk = metrics ? Math.round(metrics.diskUsedPct) : 0;
  // 磁盘详情优先取根分区，其次第一个分区
  const rootDisk =
    metrics?.disks.find((d) => d.mount === "/") ?? metrics?.disks[0];

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
          <div className="right-panel__empty">
            <Icon name="plug" size={20} />
            <span className="right-panel__empty-text">未连接服务器</span>
            <span className="right-panel__empty-sub">连接会话后在此查看实时资源占用</span>
          </div>
        ) : (
          <>
        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="cpu" size={14} />CPU
            </span>
            <span className="res-card__value" style={{ color: resTextColor(cpu) }}>
              {cpu}%
            </span>
          </div>
          <div className="res-bar">
            <div
              className={"res-bar__fill " + resBarColor(cpu)}
              style={{ width: Math.min(cpu, 100) + "%" }}
            />
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
          </>
        )}

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
                  {(t.status === "running" || t.status === "paused") && (
                    <button
                      className="ds-btn ds-btn--tertiary ds-btn--icon"
                      type="button"
                      title={t.status === "running" ? "暂停" : "恢复"}
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
        </div>
      </div>
    </div>
  );
}
