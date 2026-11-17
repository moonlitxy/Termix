import { useApp } from "../store/app";
import { selectMonitorConnection, useMonitor } from "../store/monitor";
import { toast } from "../store/feedback";

function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function formatUptime(sec: number): string {
  if (!sec) return "-";
  const days = Math.floor(sec / 86400);
  if (days > 0) return `${days} 天`;
  const hours = Math.floor(sec / 3600);
  if (hours > 0) return `${hours} 小时`;
  return `${Math.max(1, Math.floor(sec / 60))} 分钟`;
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
  ready,
  placeholder = "-",
}: {
  label: string;
  value: number;
  detail?: string;
  ready: boolean;
  placeholder?: string;
}) {
  return (
    <div className="sidebar-stat" title={detail}>
      <span>{label}</span>
      <span className="sidebar-stat__track">
        <span
          className="sidebar-stat__fill"
          style={{
            width: ready ? `${Math.min(100, Math.max(0, value))}%` : 0,
            background: barColor(value),
          }}
        />
      </span>
      <span className="sidebar-stat__value">
        {ready ? `${value}%` : placeholder}
      </span>
    </div>
  );
}

function MetaRows({
  uptime,
  load,
}: {
  uptime: string;
  load: string;
}) {
  return (
    <div className="sidebar-stats__meta">
      <span className="sidebar-stats__meta-label">运行</span>
      <span className="sidebar-stats__meta-value">{uptime}</span>
      <span className="sidebar-stats__meta-label">负载</span>
      <span className="sidebar-stats__meta-value sidebar-stats__meta-value--load">
        {load}
      </span>
    </div>
  );
}

export function SidebarStats() {
  const sessions = useApp((s) => s.sessions);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const sftpContext = useApp((s) => s.sftpContext);
  const setActivity = useApp((s) => s.setActivity);

  const metrics = useMonitor((s) => s.metrics);
  const netSpeed = useMonitor((s) => s.netSpeed);
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
              未连接
            </div>
          </div>
          <button className="sidebar-stats__copy" type="button" disabled>
            复制
          </button>
        </div>
        <button className="sidebar-stats__sysinfo" type="button" disabled>
          系统信息
        </button>
        <MetaRows uptime="-" load="-" />
        <Metric
          label="CPU"
          value={0}
          ready={false}
          placeholder="0%"
          detail="连接后显示 CPU 使用率"
        />
        <Metric
          label="内存"
          value={0}
          ready={false}
          placeholder="0%"
          detail="连接后显示内存用量"
        />
        <Metric
          label="磁盘"
          value={0}
          ready={false}
          placeholder="0%"
          detail="连接后显示磁盘用量"
        />
        <div className="sidebar-stats__net">
          <span>↑ 0 B/s</span>
          <span>↓ 0 B/s</span>
          <button type="button" disabled>
            详情
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
  const rootDisk = metrics?.disks.find((item) => item.mount === "/") ?? metrics?.disks[0];

  const copyInfo = async () => {
    try {
      await navigator.clipboard.writeText(
        `${session.username}@${session.host}:${session.port}`
      );
      toast.success("连接信息已复制");
    } catch {
      toast.error("复制连接信息失败");
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
            已连接 · {session.username}
          </div>
        </div>
        <button
          className="sidebar-stats__copy"
          type="button"
          title="复制连接信息"
          onClick={() => void copyInfo()}
        >
          复制
        </button>
      </div>
      <MetaRows
        uptime={metrics ? formatUptime(metrics.uptime) : "-"}
        load={load}
      />
      <Metric
        label="CPU"
        value={metrics ? cpu : 0}
        ready={!!metrics}
        detail={metrics ? `CPU ${cpu}%` : "等待采样"}
      />
      <Metric
        label="内存"
        value={metrics ? memPct : 0}
        ready={!!metrics}
        detail={
          metrics
            ? `内存 ${formatBytes(metrics.memUsed)} / ${formatBytes(metrics.memTotal)}`
            : "等待采样"
        }
      />
      <Metric
        label="磁盘"
        value={metrics ? disk : 0}
        ready={!!metrics}
        detail={
          metrics
            ? `磁盘 ${formatBytes(rootDisk?.used ?? 0)} / ${formatBytes(rootDisk?.total ?? 0)}`
            : "等待采样"
        }
      />
      <div className="sidebar-stats__net">
        <span>↑ {formatBytes(netSpeed.tx)}/s</span>
        <span>↓ {formatBytes(netSpeed.rx)}/s</span>
        <button type="button" onClick={() => setActivity("monitor")}>
          详情
        </button>
      </div>
    </div>
  );
}
