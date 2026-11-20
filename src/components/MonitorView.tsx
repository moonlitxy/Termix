import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { useMonitor, selectMonitorConnection } from "../store/monitor";
import { ipc } from "../lib/ipc";
import { loadSettings, SETTINGS_CHANGE_EVENT } from "../lib/settings";
import { resBarColor, resTextColor } from "../lib/resColor";
import { formatBytePair, formatBytes } from "../lib/formatBytes";
import { useT } from "../lib/i18n";
import type { ProcInfo } from "../types";

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
  const t = useT();
  const sftpContext = useApp((s) => s.sftpContext);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const [procs, setProcs] = useState<ProcInfo[]>([]);

  // ---- 指标数据统一来自共享监控数据源（与终端右侧资源监控同一份，单一轮询） ----
  const metrics = useMonitor((s) => s.metrics);
  const netSpeed = useMonitor((s) => s.netSpeed);
  const cpuHist = useMonitor((s) => s.cpuHist);
  const sysInfo = useMonitor((s) => s.sysInfo);

  const connectionId = selectMonitorConnection(sftpContext, tabs, activeTabId);

  useEffect(() => {
    if (!connectionId) {
      setProcs([]);
      return;
    }
    let stopped = false;
    let pv: number | undefined;
    // 进程 Top 列表（MonitorView 专属）：扫描成本高于基础指标，默认至少 10 秒刷新一次。
    const startProcs = () => {
      clearInterval(pv);
      const interval = loadSettings().monitorInterval;
      const load = async () => {
        try {
          const p = await ipc.monitorProcesses(connectionId, 20);
          if (!stopped) setProcs(p);
        } catch {
          /* ignore */
        }
      };
      void load();
      pv = setInterval(() => void load(), Math.max(interval * 3, 10000));
    };
    startProcs();
    const onSettings = () => startProcs();
    window.addEventListener(SETTINGS_CHANGE_EVENT, onSettings);
    return () => {
      stopped = true;
      window.removeEventListener(SETTINGS_CHANGE_EVENT, onSettings);
      clearInterval(pv);
    };
  }, [connectionId]);

  if (!connectionId) {
    return (
      <div className="workspace__empty">
        <span className="workspace__empty-logo">
          <Icon name="bar" size={28} />
        </span>
        <div className="workspace__empty-text">{t("mon.emptyTitle")}</div>
        <div className="workspace__empty-sub">{t("mon.emptySub")}</div>
      </div>
    );
  }

  const cpu = metrics?.cpu ?? 0;
  const memPct = metrics && metrics.memTotal > 0 ? (metrics.memUsed / metrics.memTotal) * 100 : 0;
  const disk = metrics?.diskUsedPct ?? 0;
  const sysMemUsed = metrics?.memUsed ?? sysInfo?.memUsed ?? 0;
  const sysMemTotal = metrics?.memTotal ?? sysInfo?.memTotal ?? 0;
  // 磁盘详情优先取根分区，其次第一个分区
  const rootDisk =
    metrics?.disks.find((d) => d.mount === "/") ?? metrics?.disks[0];

  return (
    <div className="mon-view">
      <div className="ds-card sys-card" aria-busy={!sysInfo}>
        <div className="res-card__head">
          <span className="res-card__label">
            <Icon name="cpu" size={14} />{t("mon.sysinfo")}
          </span>
        </div>
        <div className="sys-grid">
          <div className="sys-item">
            <span className="sys-item__label">{t("mon.os")}</span>
            <span className="sys-item__value" title={sysInfo?.osName}>
              {sysInfo?.osName || "-"}
              {sysInfo?.osVersion ? ` (${sysInfo.osVersion})` : ""}
            </span>
          </div>
          <div className="sys-item">
            <span className="sys-item__label">{t("mon.kernel")}</span>
            <span className="sys-item__value">{sysInfo?.kernel || "-"}</span>
          </div>
          <div className="sys-item">
            <span className="sys-item__label">{t("mon.arch")}</span>
            <span className="sys-item__value">{sysInfo?.arch || "-"}</span>
          </div>
          <div className="sys-item">
            <span className="sys-item__label">{t("mon.cpu")}</span>
            <span className="sys-item__value" title={sysInfo?.cpuModel}>
              {sysInfo?.cpuCores ? t("mon.cores", { n: sysInfo.cpuCores }) : "-"}
              {sysInfo?.cpuModel ? ` · ${sysInfo.cpuModel}` : ""}
            </span>
          </div>
          <div className="sys-item">
            <span className="sys-item__label">{t("mon.memory")}</span>
            <span className="sys-item__value">
              {sysMemTotal > 0
                ? `${formatBytePair(sysMemUsed, sysMemTotal)} (${((sysMemUsed / sysMemTotal) * 100).toFixed(1)}%)`
                : "-"}
            </span>
          </div>
        </div>
      </div>

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
              <Icon name="bar" size={14} />{t("mon.memory")}
            </span>
            <span className="res-card__value" style={{ color: resTextColor(memPct) }}>
              {memPct.toFixed(1)}%
            </span>
          </div>
          <div className="res-bar">
            <div className={"res-bar__fill " + resBarColor(memPct)} style={{ width: Math.min(memPct, 100) + "%" }} />
          </div>
          <div className="res-card__detail">
            {metrics ? `${formatBytePair(metrics.memUsed, metrics.memTotal)}（${memPct.toFixed(1)}%）` : "-"}
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
              ? `${formatBytePair(rootDisk?.used ?? 0, rootDisk?.total ?? 0)}（${disk.toFixed(0)}%）`
              : "-"}
          </div>
        </div>
        <div className="ds-card mon-card">
          <div className="res-card__head">
            <span className="res-card__label">
              <Icon name="arrow-right-to-line" size={14} />{t("mon.network")}
            </span>
          </div>
          <div className="net-row">
            <span className="net-row__label">{t("mon.up")}</span>
            <span className="net-row__value">{formatBytes(netSpeed.tx)}/s</span>
          </div>
          <div className="net-row">
            <span className="net-row__label">{t("mon.down")}</span>
            <span className="net-row__value">{formatBytes(netSpeed.rx)}/s</span>
          </div>
          <div className="net-row">
            <span className="net-row__label">{t("mon.conns")}</span>
            <span className="net-row__value">{metrics?.netConns ?? 0}</span>
          </div>
        </div>
      </div>

      <div className="ds-card mon-chart">
        <div className="res-card__head">
          <span className="res-card__label">{t("mon.chartTitle")}</span>
        </div>
        <svg viewBox="0 0 600 160" preserveAspectRatio="none" className="mon-chart__svg">
          <polyline
            points={polyline(cpuHist)}
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
            <Icon name="folder" size={14} />{t("mon.disks")}
          </span>
        </div>
        <div className="mon-table mon-table--disks">
          <div className="mon-table__head">
            <span>{t("mon.mount")}</span>
            <span>{t("mon.total")}</span>
            <span>{t("mon.used")}</span>
            <span>{t("mon.usage")}</span>
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
              <span>{t("mon.noData")}</span>
            </div>
          )}
        </div>
      </div>

      <div className="ds-card mon-procs">
        <div className="res-card__head">
          <span className="res-card__label">{t("mon.procs")}</span>
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
