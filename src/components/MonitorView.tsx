import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import { loadSettings, SETTINGS_CHANGE_EVENT } from "../lib/settings";
import { resBarColor, resTextColor } from "../lib/resColor";
import type { Metrics, ProcInfo, SysInfo } from "../types";

function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
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
  const [sysInfo, setSysInfo] = useState<SysInfo | null>(null);
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
    let iv: number | undefined;
    let pv: number | undefined;
    // 加载服务器系统信息（连接建立时获取一次）
    setSysInfo(null);
    ipc
      .systemInfo(connectionId)
      .then((info) => {
        if (!stopped) setSysInfo(info);
      })
      .catch(() => {
        /* ignore */
      });
    // busy 防止并发轮询：monitor 命令执行时间可能长于轮询间隔，
    // 并发请求会相互覆盖采样，导致网络速率计算出现天文数字
    let busy = false;
    let lastTs = 0;

    const startTimers = () => {
      clearInterval(iv);
      clearInterval(pv);
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
          cpuHist.current = [...cpuHist.current.slice(-59), m.cpu];
          setMetrics(m);
          setTick((t) => t + 1);
        } catch {
          /* ignore */
        } finally {
          busy = false;
        }
      };
      void tick();
      iv = setInterval(() => void tick(), interval);
      pv = setInterval(async () => {
        try {
          const p = await ipc.monitorProcesses(connectionId, 20);
          if (!stopped) setProcs(p);
        } catch {
          /* ignore */
        }
      }, Math.max(interval * 2, 5000));
    };

    startTimers();
    const onSettings = () => startTimers();
    window.addEventListener(SETTINGS_CHANGE_EVENT, onSettings);
    return () => {
      stopped = true;
      window.removeEventListener(SETTINGS_CHANGE_EVENT, onSettings);
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
  // 磁盘详情优先取根分区，其次第一个分区
  const rootDisk =
    metrics?.disks.find((d) => d.mount === "/") ?? metrics?.disks[0];

  return (
    <div className="mon-view">
      {sysInfo && (
        <div className="ds-card sys-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="cpu" size={14} />系统信息
            </span>
          </div>
          <div className="sys-grid">
            <div className="sys-item">
              <span className="sys-item__label">操作系统</span>
              <span className="sys-item__value" title={sysInfo.osName}>
                {sysInfo.osName || "-"}
                {sysInfo.osVersion ? ` (${sysInfo.osVersion})` : ""}
              </span>
            </div>
            <div className="sys-item">
              <span className="sys-item__label">内核版本</span>
              <span className="sys-item__value">{sysInfo.kernel || "-"}</span>
            </div>
            <div className="sys-item">
              <span className="sys-item__label">系统架构</span>
              <span className="sys-item__value">{sysInfo.arch || "-"}</span>
            </div>
            <div className="sys-item">
              <span className="sys-item__label">CPU</span>
              <span className="sys-item__value" title={sysInfo.cpuModel}>
                {sysInfo.cpuCores ? `${sysInfo.cpuCores} 核` : "-"}
                {sysInfo.cpuModel ? ` · ${sysInfo.cpuModel}` : ""}
              </span>
            </div>
            <div className="sys-item">
              <span className="sys-item__label">内存</span>
              <span className="sys-item__value">
                {sysInfo.memTotal > 0
                  ? `${formatBytes(sysInfo.memUsed)} / ${formatBytes(sysInfo.memTotal)} (${((sysInfo.memUsed / sysInfo.memTotal) * 100).toFixed(1)}%)`
                  : "-"}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="mon-grid">
        <div className="ds-card mon-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="cpu" size={14} />CPU
            </span>
            <span className="res-card__value" style={{ color: resTextColor(cpu) }}>
              {cpu.toFixed(1)}%
            </span>
          </div>
          <div className="res-bar">
            <div className={"res-bar__fill " + resBarColor(cpu)} style={{ width: Math.min(cpu, 100) + "%" }} />
          </div>
        </div>
        <div className="ds-card mon-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="bar" size={14} />Memory
            </span>
            <span className="res-card__value" style={{ color: resTextColor(memPct) }}>
              {memPct.toFixed(1)}%
            </span>
          </div>
          <div className="res-bar">
            <div className={"res-bar__fill " + resBarColor(memPct)} style={{ width: Math.min(memPct, 100) + "%" }} />
          </div>
          <div className="res-card__detail">
            {metrics ? `${formatBytes(metrics.memUsed)} / ${formatBytes(metrics.memTotal)}` : "-"}
          </div>
        </div>
        <div className="ds-card mon-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="folder" size={14} />Disk /
            </span>
            <span className="res-card__value" style={{ color: resTextColor(disk) }}>
              {disk.toFixed(0)}%
            </span>
          </div>
          <div className="res-bar">
            <div className={"res-bar__fill " + resBarColor(disk)} style={{ width: Math.min(disk, 100) + "%" }} />
          </div>
          <div className="res-card__detail">
            {metrics
              ? `${formatBytes(rootDisk?.used ?? 0)} / ${formatBytes(rootDisk?.total ?? 0)}`
              : "-"}
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
          <div className="net-row">
            <span className="net-row__label">连接数</span>
            <span className="net-row__value">{metrics?.netConns ?? 0}</span>
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
          <span className="res-card__label">
            <Icon name="folder" size={14} />磁盘分区
          </span>
        </div>
        <div className="mon-table mon-table--disks">
          <div className="mon-table__head">
            <span>挂载点</span>
            <span>总容量</span>
            <span>已用</span>
            <span>使用率</span>
          </div>
          {(metrics?.disks ?? []).map((d) => (
            <div className="mon-table__row" key={d.mount} title={d.mount}>
              <span>{d.mount}</span>
              <span>{formatBytes(d.total)}</span>
              <span>{formatBytes(d.used)}</span>
              <span style={{ color: resTextColor(d.pct) }}>
                {d.pct.toFixed(0)}%
              </span>
            </div>
          ))}
          {(metrics?.disks ?? []).length === 0 && (
            <div className="mon-table__row">
              <span>暂无数据</span>
            </div>
          )}
        </div>
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
