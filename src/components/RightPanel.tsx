import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
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
      void ipc.sftpUpload(conn.connectionId, t.sessionId, t.localPath, t.remotePath);
    } else {
      void ipc.sftpDownload(conn.connectionId, t.sessionId, t.remotePath, t.localPath);
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
    const tick = async () => {
      try {
        const m = await ipc.monitorMetrics(connectionId);
        if (stopped) return;
        if (lastSample.current) {
          setNetSpeed({
            rx: Math.max(0, m.netRx - lastSample.current.netRx) / 2,
            tx: Math.max(0, m.netTx - lastSample.current.netTx) / 2,
          });
        }
        lastSample.current = m;
        setMetrics(m);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [connectionId]);

  const cpu = metrics ? Math.round(metrics.cpu) : 24;
  const memPct = metrics && metrics.memTotal > 0 ? Math.round((metrics.memUsed / metrics.memTotal) * 100) : 26;
  const disk = metrics ? Math.round(metrics.diskUsedPct) : 38;

  return (
    <div className="right-panel">
      <div className="right-panel__header">
        <span>资源监控</span>
        <button className="ds-btn ds-btn--tertiary ds-btn--icon" type="button" title="刷新">
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <div className="right-panel__body">
        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="cpu" size={14} />CPU
            </span>
            <span className="res-card__value">{cpu}%</span>
          </div>
          <div className="res-bar">
            <div
              className="res-bar__fill res-bar__fill--success"
              style={{ width: Math.min(cpu, 100) + "%" }}
            />
          </div>
        </div>
        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="bar" size={14} />Memory
            </span>
            <span className="res-card__value">
              {metrics
                ? formatBytes(metrics.memUsed) + " / " + formatBytes(metrics.memTotal)
                : "4.2G / 16G"}
            </span>
          </div>
          <div className="res-bar">
            <div
              className="res-bar__fill res-bar__fill--primary"
              style={{ width: Math.min(memPct, 100) + "%" }}
            />
          </div>
        </div>
        <div className="ds-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="folder" size={14} />Disk /
            </span>
            <span className="res-card__value">{disk}%</span>
          </div>
          <div className="res-bar">
            <div
              className="res-bar__fill res-bar__fill--warning"
              style={{ width: Math.min(disk, 100) + "%" }}
            />
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
          </div>
        </div>

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
                  {t.status === "running" && (
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
