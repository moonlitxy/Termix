import { useApp } from "../store/app";
import { selectMonitorConnection, useMonitor } from "../store/monitor";
import { toast } from "../store/feedback";
import { formatBytePair, formatBytes } from "../lib/formatBytes";
import { getLang, useT } from "../lib/i18n";

function formatUptime(sec: number, en: boolean): string {
  if (!sec) return "-";
  const days = Math.floor(sec / 86400);
  if (days > 0) return en ? `${days}d` : `${days} 天`;
  const hours = Math.floor(sec / 3600);
  if (hours > 0) return en ? `${hours}h` : `${hours} 小时`;
  const mins = Math.max(1, Math.floor(sec / 60));
  return en ? `${mins}m` : `${mins} 分钟`;
}

function barColor(pct: number): string {
  if (pct >= 85) return "var(--status-error-default)";
  if (pct >= 70) return "var(--status-warning-default)";
  return "var(--status-success-default)";
}

function Metric({
  label,
  value,
  detail,
  title,
  ready,
  placeholder = "-",
}: {
  label: string;
  value: number;
  detail?: string;
  title?: string;
  ready: boolean;
  placeholder?: string;
}) {
  return (
    <div className="sidebar-stat" title={title}>
      <span className="sidebar-stat__label">{label}</span>
      <span className="sidebar-stat__meter">
        <span
          className="sidebar-stat__fill"
          style={{
            width: ready ? `${Math.min(100, Math.max(0, value))}%` : 0,
            background: barColor(value),
          }}
        />
        <span className="sidebar-stat__pct">
          {ready ? `${value}%` : placeholder}
        </span>
        {ready && detail && (
          <span className="sidebar-stat__detail">{detail}</span>
        )}
      </span>
    </div>
  );
}

function MetaRows({
  uptime,
  load,
  loadTitle,
}: {
  uptime: string;
  load: string;
  loadTitle?: string;
}) {
  const t = useT();
  return (
    <div className="sidebar-stats__meta">
      <span className="sidebar-stats__meta-label">{t("stats.run")}</span>
      <span className="sidebar-stats__meta-value">{uptime}</span>
      <span className="sidebar-stats__meta-label">{t("stats.load")}</span>
      <span
        className="sidebar-stats__meta-value sidebar-stats__meta-value--load"
        title={loadTitle}
      >
        {load}
      </span>
    </div>
  );
}

export function SidebarStats() {
  const t = useT();
  const sessions = useApp((s) => s.sessions);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const sftpContext = useApp((s) => s.sftpContext);
  const setActivity = useApp((s) => s.setActivity);

  const metrics = useMonitor((s) => s.metrics);
  const netSpeed = useMonitor((s) => s.netSpeed);
  const cpuMeta = useMonitor((s) => s.cpuMeta);
  const connectionId = selectMonitorConnection(sftpContext, tabs, activeTabId);
  const connectionTab =
    tabs.find((tab) => tab.connectionId === connectionId) ??
    tabs.find((tab) => tab.id === activeTabId);
  const session = connectionTab
    ? sessions.find((item) => item.id === connectionTab.sessionId)
    : null;

  if (!connectionId || !session) {
    return (
      <div className="sidebar-stats sidebar-stats--empty">
        <div className="sidebar-stats__head">
          <div style={{ minWidth: 0 }}>
            <div className="sidebar-stats__host">IP -</div>
            <div className="sidebar-stats__status">
              <span className="ds-dot ds-dot--muted" />
              {t("stats.notConnected")}
            </div>
          </div>
          <button className="sidebar-stats__copy" type="button" disabled>
            {t("stats.copy")}
          </button>
        </div>
        <button className="sidebar-stats__sysinfo" type="button" disabled>
          {t("stats.sysinfo")}
        </button>
        <MetaRows uptime="-" load="-" />
        <Metric
          label="CPU"
          value={0}
          ready={false}
          placeholder="0%"
          title={t("stats.noConnCpu")}
        />
        <Metric
          label={t("stats.memory")}
          value={0}
          ready={false}
          placeholder="0%"
          title={t("stats.noConnMem")}
        />
        <Metric
          label={t("stats.disk")}
          value={0}
          ready={false}
          placeholder="0%"
          title={t("stats.noConnDisk")}
        />
        <div className="sidebar-stats__net">
          <span>↑ 0 B/s</span>
          <span>↓ 0 B/s</span>
          <button type="button" disabled>
            {t("common.details")}
          </button>
        </div>
      </div>
    );
  }

  const cpu = metrics ? Math.round(metrics.cpu) : 0;
  const memPct =
    metrics && metrics.memTotal > 0
      ? Math.round((metrics.memUsed / metrics.memTotal) * 100)
      : 0;
  const disk = metrics ? Math.round(metrics.diskUsedPct) : 0;
  const load = metrics
    ? `${metrics.load1.toFixed(2)} ${metrics.load5.toFixed(2)} ${metrics.load15.toFixed(2)}`
    : "-";
  const loadTitle = metrics
    ? cpuMeta?.cores
      ? t("stats.loadTitleCores", { n: cpuMeta.cores })
      : t("stats.loadTitle")
    : undefined;
  const rootDisk = metrics?.disks.find((item) => item.mount === "/") ?? metrics?.disks[0];

  const copyInfo = async () => {
    try {
      await navigator.clipboard.writeText(
        `${session.username}@${session.host}:${session.port}`
      );
      toast.success(t("stats.copied"));
    } catch {
      toast.error(t("stats.copyFailed"));
    }
  };

  return (
    <div className="sidebar-stats">
      <div className="sidebar-stats__head">
        <div style={{ minWidth: 0 }}>
          <div className="sidebar-stats__host" title={session.host}>
            {session.host}
          </div>
          <div className="sidebar-stats__status">
            <span className="ds-dot ds-dot--success-glow" />
            {t("conn.connected")} · {session.username}
          </div>
        </div>
        <button
          className="sidebar-stats__copy"
          type="button"
          title={t("stats.copyConn")}
          onClick={() => void copyInfo()}
        >
          {t("stats.copy")}
        </button>
      </div>
      <MetaRows
        uptime={metrics ? formatUptime(metrics.uptime, getLang() === "en") : "-"}
        load={load}
        loadTitle={loadTitle}
      />
      <Metric
        label="CPU"
        value={metrics ? cpu : 0}
        ready={!!metrics}
        detail={cpuMeta?.cores ? t("stats.cores", { n: cpuMeta.cores }) : undefined}
        title={
          metrics
            ? t("stats.cpuDetail", {
                cpu,
                extra:
                  cpuMeta?.cores || cpuMeta?.freq
                    ? t("stats.cpuCoresFreq", {
                        cores: cpuMeta?.cores ? t("stats.cores", { n: cpuMeta.cores }) : "",
                        freq: cpuMeta?.freq ? ` · ${cpuMeta.freq}` : "",
                      })
                    : "",
              })
            : t("stats.cpuWaiting")
        }
      />
      <Metric
        label={t("stats.memory")}
        value={metrics ? memPct : 0}
        ready={!!metrics}
        detail={metrics ? formatBytePair(metrics.memUsed, metrics.memTotal) : undefined}
        title={
          metrics
            ? t("stats.memDetail", {
                pair: formatBytePair(metrics.memUsed, metrics.memTotal),
                pct: memPct,
              })
            : t("stats.waiting")
        }
      />
      <Metric
        label={t("stats.disk")}
        value={metrics ? disk : 0}
        ready={!!metrics}
        detail={
          metrics
            ? formatBytePair(rootDisk?.used ?? 0, rootDisk?.total ?? 0)
            : undefined
        }
        title={
          metrics
            ? t("stats.diskDetail", {
                pair: formatBytePair(rootDisk?.used ?? 0, rootDisk?.total ?? 0),
                pct: disk,
              })
            : t("stats.waiting")
        }
      />
      <div className="sidebar-stats__net">
        <span>↑ {formatBytes(netSpeed.tx)}/s</span>
        <span>↓ {formatBytes(netSpeed.rx)}/s</span>
        <button type="button" onClick={() => setActivity("monitor")}>
          {t("common.details")}
        </button>
      </div>
    </div>
  );
}
