import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { loadSettings, SETTINGS_CHANGE_EVENT } from "../lib/settings";
import type { Metrics } from "../types";

/**
 * 全局共享的监控数据源（单一轮询循环）。
 *
 * 终端右侧资源监控面板与「监控」模块均从本 store 读取同一份数据，
 * 避免两处各自轮询导致采样时刻、历史曲线、运行时长等展示不一致。
 * 轮询目标由 App 根据连接状态统一驱动（sync），组件只读不做轮询。
 */

/** 最近一次成功采样距今超过该阈值即视为连接失联（固定值）。
    不随「监控刷新间隔」配置变化：运行时长以本地时钟每秒补偿递增，
    即使刷新间隔调大，运行时间显示仍保持真实、连续。 */
const STALE_MS = 15_000;

/** 从 CPU 型号中提取主频（如 "Intel(R) Xeon(R) CPU @ 2.50GHz" → "2.50 GHz"） */
export function extractCpuFreq(model: string): string {
  const m = model.match(/@\s*([\d.]+)\s*GHz/i);
  return m ? `${m[1]} GHz` : "";
}

/** 统一监控连接推导：优先 SFTP 面板绑定的已连接会话，其次第一个已连接会话。
    两个展示模块共用同一规则，保证数据源完全一致。 */
export function selectMonitorConnection(
  sftpContext: { connectionId: string } | null,
  tabs: { connectionId?: string; status: string }[]
): string | null {
  if (
    sftpContext &&
    tabs.some(
      (t) => t.connectionId === sftpContext.connectionId && t.status === "connected"
    )
  ) {
    return sftpContext.connectionId;
  }
  return (
    tabs.find((t) => t.status === "connected" && t.connectionId)?.connectionId ??
    null
  );
}

/** 运行时长 = 最近采样 uptime + 本地流逝时间（秒级实时补偿）。
    连接失联（超过固定阈值无新采样）时返回 0，避免断开后继续虚增。 */
export function computeUptimeSec(
  metrics: Metrics | null,
  uptimeBase: { uptime: number; ts: number },
  lastSampleAt: number,
  nowTs: number
): number {
  if (!metrics || lastSampleAt <= 0 || nowTs - lastSampleAt > STALE_MS) return 0;
  return uptimeBase.uptime + Math.max(0, (nowTs - uptimeBase.ts) / 1000);
}

export interface CpuMeta {
  cores: number;
  freq: string;
}

interface MonitorState {
  /** 当前监控的连接（null = 无连接，停止采集） */
  connectionId: string | null;
  metrics: Metrics | null;
  netSpeed: { rx: number; tx: number };
  cpuMeta: CpuMeta | null;
  /** CPU 使用率滚动历史（近 60 个采样），驱动迷你曲线 */
  cpuHist: number[];
  /** 最近一次成功采样的本地时刻 */
  lastSampleAt: number;
  /** 运行时长基准：最近采样 uptime 与其本地时刻 */
  uptimeBase: { uptime: number; ts: number };
  /** 每秒 tick 的本地时刻，驱动运行时长秒级递增 */
  nowTs: number;

  /** 与目标连接同步（幂等）：连接变化时重启唯一轮询，无连接时停止并清空 */
  sync: (connId: string | null) => void;
}

let pollTimer: number | null = null;
let tickTimer: number | null = null;
let settingsListener: (() => void) | null = null;

function clearTimers() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (settingsListener) {
    window.removeEventListener(SETTINGS_CHANGE_EVENT, settingsListener);
    settingsListener = null;
  }
}

function startPolling(
  connId: string,
  set: (p: Partial<MonitorState> | ((s: MonitorState) => Partial<MonitorState>)) => void,
  get: () => MonitorState
) {
  // 每秒 tick：本地时钟驱动运行时长连续递增，与监控刷新间隔无关
  tickTimer = window.setInterval(() => set({ nowTs: Date.now() }), 1000);

  // 连接建立时获取一次 CPU 硬件信息（核心数/主频）
  ipc
    .systemInfo(connId)
    .then((info) => {
      if (get().connectionId === connId) {
        set({ cpuMeta: { cores: info.cpuCores, freq: extractCpuFreq(info.cpuModel) } });
      }
    })
    .catch(() => {
      /* ignore */
    });

  let busy = false;
  let lastTs = 0;
  let lastSample: Metrics | null = null;

  const start = () => {
    if (pollTimer !== null) clearInterval(pollTimer);
    const interval = loadSettings().monitorInterval;
    const tick = async () => {
      if (busy || get().connectionId !== connId) return;
      busy = true;
      const ts = Date.now();
      try {
        const m = await ipc.monitorMetrics(connId);
        if (get().connectionId !== connId) return;
        if (lastSample && lastTs > 0) {
          const dt = (ts - lastTs) / 1000; // 实际采样间隔（秒）
          if (dt > 0) {
            set({
              netSpeed: {
                rx: Math.max(0, m.netRx - lastSample.netRx) / dt,
                tx: Math.max(0, m.netTx - lastSample.netTx) / dt,
              },
            });
          }
        }
        lastSample = m;
        lastTs = ts;
        set((s) => ({
          metrics: m,
          uptimeBase: { uptime: m.uptime, ts },
          lastSampleAt: ts,
          cpuHist: [...s.cpuHist.slice(-59), m.cpu],
        }));
      } catch {
        /* 采样失败忽略：下次轮询重试 */
      } finally {
        busy = false;
      }
    };
    void tick();
    pollTimer = window.setInterval(() => void tick(), interval);
  };

  start();
  // 监控刷新间隔设置变化时按新间隔重启轮询
  if (settingsListener) {
    window.removeEventListener(SETTINGS_CHANGE_EVENT, settingsListener);
  }
  settingsListener = start;
  window.addEventListener(SETTINGS_CHANGE_EVENT, settingsListener);
}

const EMPTY = {
  connectionId: null as string | null,
  metrics: null as Metrics | null,
  netSpeed: { rx: 0, tx: 0 },
  cpuMeta: null as CpuMeta | null,
  cpuHist: [] as number[],
  lastSampleAt: 0,
  uptimeBase: { uptime: 0, ts: 0 },
  nowTs: 0,
};

export const useMonitor = create<MonitorState>((set, get) => ({
  ...EMPTY,

  sync: (connId) => {
    if (connId === get().connectionId) return; // 目标未变，保持现有轮询
    clearTimers();
    if (!connId) {
      set({ ...EMPTY });
      return;
    }
    set({ ...EMPTY, connectionId: connId });
    startPolling(connId, set, get);
  },
}));
