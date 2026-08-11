import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import type { Metrics, ProcInfo } from "../types";

function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function barColor(pct: number): string {
  if (pct < 70) return "res-bar__fill--success";
  if (pct < 90) return "res-bar__fill--warning";
  return "res-bar__fill--error";
}

function polyline(points: number[], width = 600, height = 160): string {
  if (points.length === 0) return "";
  const max = Math.max(...points, 1);
  return points
    .map((v, i) => {
      const x = (i / Math.max(points.length - 1, 1)) * width;
      const y = height - (v / max) * (height - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function MonitorView() {
  const sftpContext = useApp((s) => s.sftpContext);
  const tabs = useApp((s) => s.tabs);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [procs, setProcs] = useState<ProcInfo[]>([]);
  const [netSpeed, setNetSpeed] = useState({ rx: 0, tx: 0 });
  const cpuHist = useRef<number[]>([]);
  const [, setTick] = useState(0);
  const lastSample = useRef<Metrics | null>(null);

  const connectionId =
    sftpContext?.connectionId ??
    tabs.find((t) => t.status === "connected" && t.connectionId)?.connectionId ??
    null;

  useEffect(() => {
    if (!connectionId) {
      setMetrics(null);
      setProcs([]);
      return;
    }
    let stopped = false;
    const tick = async () => {
      try {
        const m = await ipc.monitorMetrics(connectionId);
        if (stopped) return;
        if (lastSample.current) {
          const dt = 2;
          setNetSpeed({
            rx: Math.max(0, m.netRx - lastSample.current.netRx) / dt,
            tx: Math.max(0, m.netTx - lastSample.current.netTx) / dt,
          });
        }
        lastSample.current = m;
        cpuHist.current = [...cpuHist.current.slice(-59), m.cpu];
        setMetrics(m);
        setTick((t) => t + 1);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 2000);
    const pv = setInterval(async () => {
      try {
        const p = await ipc.monitorProcesses(connectionId, 20);
        if (!stopped) setProcs(p);
      } catch {
        /* ignore */
      }
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(iv);
      clearInterval(pv);
    };
  }, [connectionId]);

  if (!connectionId) {
    return (
      <div className="workspace__empty">
        <span className="workspace__empty-logo">
          <Icon name="bar" size={56} />
        </span>
        <div className="workspace__empty-text">请先连接一个会话</div>
        <div className="workspace__empty-sub">打开终端连接后即可查看实时监控</div>
      </div>
    );
  }

  const cpu = metrics?.cpu ?? 0;
  const memPct = metrics && metrics.memTotal > 0 ? (metrics.memUsed / metrics.memTotal) * 100 : 0;
  const disk = metrics?.diskUsedPct ?? 0;

  return (
    <div className="mon-view">
      <div className="mon-grid">
        <div className="ds-card mon-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="cpu" size={14} />CPU
            </span>
            <span className="res-card__value">{cpu.toFixed(1)}%</span>
          </div>
          <div className="res-bar">
            <div className={"res-bar__fill " + barColor(cpu)} style={{ width: Math.min(cpu, 100) + "%" }} />
          </div>
        </div>
        <div className="ds-card mon-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="bar" size={14} />Memory
            </span>
            <span className="res-card__value">
              {metrics ? formatBytes(metrics.memUsed) + " / " + formatBytes(metrics.memTotal) : "-"}
            </span>
          </div>
          <div className="res-bar">
            <div className="res-bar__fill res-bar__fill--primary" style={{ width: Math.min(memPct, 100) + "%" }} />
          </div>
        </div>
        <div className="ds-card mon-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="folder" size={14} />Disk /
            </span>
            <span className="res-card__value">{disk.toFixed(0)}%</span>
          </div>
          <div className="res-bar">
            <div className={"res-bar__fill " + barColor(disk)} style={{ width: Math.min(disk, 100) + "%" }} />
          </div>
        </div>
        <div className="ds-card mon-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="arrow-right-to-line" size={14} />Network
            </span>
          </div>
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

      <div className="ds-card mon-chart">
        <div className="res-card__head">
          <span className="res-card__label">CPU 实时曲线（最近 5 分钟）</span>
        </div>
        <svg viewBox="0 0 600 160" preserveAspectRatio="none" className="mon-chart__svg">
          <polyline
            points={polyline(cpuHist.current)}
            fill="none"
            stroke="var(--bg-brand)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <div className="ds-card mon-procs">
        <div className="res-card__head">
          <span className="res-card__label">进程 Top</span>
        </div>
        <div className="mon-table">
          <div className="mon-table__head">
            <span>PID</span>
            <span>USER</span>
            <span>CPU%</span>
            <span>MEM%</span>
            <span>COMMAND</span>
          </div>
          {procs.map((p, i) => (
            <div className="mon-table__row" key={p.pid + "-" + i}>
              <span>{p.pid}</span>
              <span>{p.user}</span>
              <span>{p.cpu.toFixed(1)}</span>
              <span>{p.mem.toFixed(1)}</span>
              <span className="mon-table__cmd">{p.cmd}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
