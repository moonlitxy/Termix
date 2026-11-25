import { create } from "zustand";
import type {
  Activity,
  AppPaths,
  Group,
  Session,
  SftpItem,
  Tab,
  TransferProgressEvent,
  TransferTask,
} from "../types";
import { ipc } from "../lib/ipc";
import { loadSettings, saveSettings } from "../lib/settings";
import { setBoundedTimestampCache } from "../lib/boundedCache";
import { switchRemotePath } from "../lib/remotePath";
import {
  normalizeRemotePath,
  parseCdIntent,
  resolveCdTarget,
} from "../lib/cdPath";

interface SftpContext {
  sessionId: string;
  connectionId: string;
}

interface RemoteCacheValue {
  items: SftpItem[];
  enriched: boolean;
}

interface AppState {
  sessions: Session[];
  groups: Group[];
  tabs: Tab[];
  activeTabId: string | null;
  searchKeyword: string;
  paletteOpen: boolean;
  newConnOpen: boolean;
  editingSession: Session | null;
  /** 新建连接对话框打开时预选的分组 id（来自分组快捷入口） */
  newConnPresetGroupId: string | null;

  // v0.2
  activity: Activity;
  transfers: TransferTask[];
  sftpContext: SftpContext | null;
  remoteItems: SftpItem[];
  remotePath: string;
  /** 每条连接最后浏览的远程目录，切回标签时恢复 */
  remotePaths: Record<string, string>;
  /** 每条连接解析 ~ 用的 SFTP 家目录缓存 */
  remoteHomes: Record<string, string>;
  /** 每条 shell 最近一次 cd 后的逻辑目录（shellId 唯一） */
  shellCwds: Record<string, string>;
  remoteSelected: SftpItem | null;
  /** 本地下载目标目录（无本地文件面板，下载直接落到该目录） */
  localPath: string;
  /** 应用数据/默认下载目录（由 Rust 按安装位置解析） */
  appPaths: AppPaths | null;
  /** 远程目录列表加载中标记（用于展示加载状态，避免重复触发加载） */
  remoteLoading: boolean;
  /** 远程目录加载失败的错误信息（成功/加载中时为空） */
  remoteError: string | null;
  /** 远程目录列表缓存：connectionId|path → 条目与时间戳，短 TTL 内复用避免重复请求 */
  remoteCache: Record<string, RemoteCacheValue & { ts: number }>;
  /** SFTP 面板收起状态：收起后仅保留工具栏条 */
  sftpCollapsed: boolean;
  /** 右侧资源面板展开状态：收起时仅保留迷你指标条 */
  rightPanelExpanded: boolean;
  /** 悬浮传输窗口是否展开 */
  transferWindowOpen: boolean;
  /** 底部命令输入条展开状态：默认隐藏，Ctrl+L 唤出 */
  commandInputOpen: boolean;
  /** 各标签的重连触发计数：请求重新连接时自增，终端视图据此重建连接 */
  reconnectNonce: Record<string, number>;
  /** 帮助页滚动锚点：标题栏「关于 Termix」设置后，帮助视图挂载时定位到对应区块 */
  helpAnchor: string | null;
  /** 设置页当前激活的侧边栏页签 */
  settingsTab: "general" | "terminal" | "security" | "monitor" | "update";
  /** 同步输入：终端输入同时写到其他已连接标签（含分屏） */
  broadcastInput: boolean;

  loadSessions: () => Promise<void>;
  loadGroups: () => Promise<void>;
  setAppPaths: (paths: AppPaths) => void;
  setSearch: (kw: string) => void;
  openPalette: () => void;
  setSettingsTab: (tab: "general" | "terminal" | "security" | "monitor" | "update") => void;
  closePalette: () => void;

  addTab: (tab: Tab) => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;

  openNewConnection: (session?: Session, presetGroupId?: string) => void;
  closeNewConnection: () => void;

  setActivity: (a: Activity) => void;
  setHelpAnchor: (id: string | null) => void;
  setTransfers: (list: TransferTask[]) => void;
  upsertTransfer: (e: TransferProgressEvent) => void;
  setSftpContext: (sessionId: string, connectionId: string | null) => Promise<void>;
  loadRemote: () => Promise<void>;
  openRemoteDir: (item: SftpItem) => Promise<void>;
  upRemote: () => Promise<void>;
  syncRemoteCwd: (
    command: string,
    connectionId: string,
    shellId: string
  ) => Promise<void>;
  selectRemote: (item: SftpItem | null) => void;
  /** 目录变更（新建/重命名/删除/上传完成）后使缓存失效，下次加载强制重新请求 */
  invalidateRemoteCache: () => void;
  /** 切换 SFTP 面板收起/展开状态 */
  toggleSftpCollapsed: () => void;
  setRightPanelExpanded: (open: boolean) => void;
  setTransferWindowOpen: (open: boolean) => void;
  setCommandInputOpen: (open: boolean) => void;
  toggleBroadcastInput: () => void;
  /** 请求指定标签重新连接（外部触发，如标题栏重连按钮） */
  requestReconnect: (tabId: string) => void;
}

let tabSeq = 0;
export function nextTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now()}-${tabSeq}`;
}

/** 远程目录列表缓存有效期（毫秒） */
const REMOTE_CACHE_TTL = 5000;
/** 最多保留的目录快照数量，避免长时间浏览后缓存无限增长 */
const REMOTE_CACHE_MAX = 12;
/** 远程目录加载 in-flight 集合（key: connectionId|path），防止同路径并发重复请求 */
const inflightRemote = new Set<string>();
/** 后台补充目录大小/属主信息的 in-flight 集合（key: connectionId|path） */
const inflightEnrich = new Set<string>();
/** 已删除任务 id：抑制清空/删除后迟到的终止事件，避免行重新出现 */
const removedTransferIds = new Set<string>();
/** 最近一次清空队列的时间，用于忽略清空前创建的迟到事件 */
let transferClearAt = 0;
/** 每个 shell 的 cwd 同步序号，防止较慢的旧请求覆盖较新的目录 */
const cwdSyncSeq = new Map<string, number>();

export function joinPath(a: string, b: string): string {
  if (!a) return b;
  if (a.endsWith("/") || a.endsWith("\\")) return a + b;
  if (/^[A-Za-z]:$/.test(a)) return a + "\\" + b;
  const sep = a.includes("\\") && !a.includes("/") ? "\\" : "/";
  return a + sep + b;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return ".";
  if (i === 0) return "/";
  if (i === 2 && /^[A-Za-z]:[\\/]/.test(p)) return p.slice(0, 3);
  return p.slice(0, i);
}

export const useApp = create<AppState>((set, get) => ({
  sessions: [],
  groups: [],
  tabs: [],
  activeTabId: null,
  searchKeyword: "",
  paletteOpen: false,
  newConnOpen: false,
  editingSession: null,
  newConnPresetGroupId: null,

  activity: "terminal",
  transfers: [],
  sftpContext: null,
  remoteItems: [],
  remotePath: "/",
  remotePaths: {},
  remoteHomes: {},
  shellCwds: {},
  remoteSelected: null,
  localPath: "",
  appPaths: null,
  remoteLoading: false,
  remoteError: null,
  remoteCache: {},
  sftpCollapsed: false,
  rightPanelExpanded: false,
  transferWindowOpen: false,
  commandInputOpen: false,
  reconnectNonce: {},
  helpAnchor: null,
  settingsTab: "general",
  broadcastInput: false,

  loadSessions: async () => {
    try {
      const sessions = await ipc.sessionList();
      set({ sessions });
    } catch (e) {
      console.warn("loadSessions:", e);
    }
  },
  setAppPaths: (appPaths) => set({ appPaths }),
  loadGroups: async () => {
    try {
      const groups = await ipc.groupList();
      set({ groups });
    } catch (e) {
      console.warn("loadGroups:", e);
    }
  },
  setSearch: (kw) => set({ searchKeyword: kw }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),

  addTab: (tab) =>
    set((s) => ({
      tabs: [...s.tabs, tab],
      // 分屏 pane 标签不改变当前激活标签
      activeTabId: tab.hidden ? s.activeTabId : tab.id,
    })),
  setActiveTab: (id) => set({ activeTabId: id }),
  closeTab: (id) =>
    set((s) => {
      // 关闭标签时级联关闭其分屏 pane 标签
      const tabs = s.tabs.filter((t) => t.id !== id && t.splitOf !== id);
      const activeTabId =
        s.activeTabId === id
          ? (tabs.filter((t) => !t.hidden).pop()?.id ?? null)
          : s.activeTabId;
      return { tabs, activeTabId };
    }),
  updateTab: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  openNewConnection: (session, presetGroupId) =>
    set({
      newConnOpen: true,
      editingSession: session ?? null,
      newConnPresetGroupId: presetGroupId ?? null,
    }),
  closeNewConnection: () =>
    set({ newConnOpen: false, editingSession: null, newConnPresetGroupId: null }),

  setActivity: (a) => set({ activity: a }),
  setHelpAnchor: (id) => set({ helpAnchor: id }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  setTransfers: (list) => set({ transfers: list }),
  upsertTransfer: (e) =>
    set((s) => {
      if (e.removedAll) {
        transferClearAt = Date.now();
        removedTransferIds.clear();
        return { transfers: [] };
      }
      if (e.removed) {
        removedTransferIds.add(e.taskId);
        return {
          transfers: s.transfers.filter((task) => task.id !== e.taskId),
        };
      }
      if (removedTransferIds.has(e.taskId)) return {};
      if (e.createdAt && transferClearAt && e.createdAt < transferClearAt) {
        return {};
      }
      const tasks = [...s.transfers];
      const idx = tasks.findIndex((t) => t.id === e.taskId);
      if (idx >= 0) {
        const t = tasks[idx];
        tasks[idx] = {
          ...t,
          fileName: e.fileName ?? t.fileName,
          direction: (e.direction as "upload" | "download") ?? t.direction,
          sessionId: e.sessionId || t.sessionId,
          connectionId: e.connectionId || t.connectionId,
          localPath: e.localPath || t.localPath,
          remotePath: e.remotePath || t.remotePath,
          isDir: e.isDir ?? t.isDir,
          status: (e.status as TransferTask["status"]) ?? t.status,
          progress: e.progress ?? t.progress,
          speed: e.speed ?? t.speed,
          transferredBytes: e.transferredBytes ?? t.transferredBytes,
          totalBytes: e.totalBytes ?? t.totalBytes,
          error:
            e.error ??
            (e.status === "running" || e.status === "completed" ? undefined : t.error),
          createdAt: e.createdAt ?? t.createdAt,
        };
      } else if (e.fileName) {
        tasks.unshift({
          id: e.taskId,
          sessionId: e.sessionId ?? "",
          connectionId: e.connectionId ?? "",
          fileName: e.fileName,
          direction: e.direction === "download" ? "download" : "upload",
          localPath: e.localPath ?? "",
          remotePath: e.remotePath ?? "",
          status: (e.status as TransferTask["status"]) ?? "running",
          progress: e.progress ?? 0,
          speed: e.speed ?? 0,
          transferredBytes: e.transferredBytes ?? 0,
          totalBytes: e.totalBytes ?? 0,
          error: e.error,
          isDir: e.isDir ?? false,
          createdAt: e.createdAt ?? Date.now(),
        });
      }
      return { transfers: tasks };
    }),

  setSftpContext: async (sessionId, connectionId) => {
    const previous = get().sftpContext;
    const navigation = switchRemotePath(
      get().remotePaths,
      previous
        ? { connectionId: previous.connectionId, path: get().remotePath }
        : null,
      connectionId
    );
    set({
      sftpContext: connectionId ? { sessionId, connectionId } : null,
      remotePath: navigation.path,
      remotePaths: navigation.paths,
      remoteSelected: null,
    });
    await get().loadRemote();
  },
  loadRemote: async () => {
    const { sftpContext, remotePath } = get();
    if (!sftpContext) {
      set({ remoteItems: [], remoteLoading: false, remoteError: null });
      return;
    }
    const key = `${sftpContext.connectionId}|${remotePath}`;
    const startEnrich = () => {
      const latest = get().remoteCache[key];
      if (latest?.enriched || inflightEnrich.has(key)) return;
      inflightEnrich.add(key);
      const startedAt = Date.now();
      void ipc
        .sftpEnrich(sftpContext.connectionId, remotePath)
        .then((items) => {
          // 目录在此期间被刷新/变更（新建、删除、再次进入）时丢弃过期结果
          const current = get().remoteCache[key];
          if (current && current.ts > startedAt) return;
          set((s) => {
            const remoteCache = setBoundedTimestampCache<RemoteCacheValue>(
              s.remoteCache,
              key,
              { items, ts: Date.now(), enriched: true },
              REMOTE_CACHE_MAX
            );
            return s.sftpContext?.connectionId === sftpContext.connectionId &&
              s.remotePath === remotePath
              ? { remoteItems: items, remoteCache }
              : { remoteCache };
          });
        })
        .catch((e) => console.warn("enrichRemote:", e))
        .finally(() => inflightEnrich.delete(key));
    };
    // 短 TTL 缓存命中：复用上次结果，避免进入/切换目录时重复发起 SFTP 请求
    const cached = get().remoteCache[key];
    if (cached && Date.now() - cached.ts < REMOTE_CACHE_TTL) {
      set({ remoteItems: cached.items, remoteLoading: false, remoteError: null });
      startEnrich();
      return;
    }
    // 并发保护：同一路径已有请求在途时不再重复发起
    if (inflightRemote.has(key)) return;
    inflightRemote.add(key);
    // 发起新加载时清空上次错误，避免切换目录后残留旧错误提示
    set({ remoteLoading: true, remoteError: null });
    try {
      const items = await ipc.sftpList(sftpContext.connectionId, remotePath);
      inflightRemote.delete(key);
      set((s) => {
        const remoteCache = setBoundedTimestampCache<RemoteCacheValue>(
          s.remoteCache,
          key,
          { items, ts: Date.now(), enriched: false },
          REMOTE_CACHE_MAX
        );
        // 快速切换标签/目录后，旧请求可能晚于新请求返回，不能覆盖当前面板
        return s.sftpContext?.connectionId === sftpContext.connectionId &&
          s.remotePath === remotePath
          ? { remoteItems: items, remoteLoading: false, remoteError: null, remoteCache }
          : { remoteCache };
      });
      startEnrich();
    } catch (e) {
      inflightRemote.delete(key);
      console.warn("loadRemote:", e);
      const isCurrent = () => {
        const current = get();
        return (
          current.sftpContext?.connectionId === sftpContext.connectionId &&
          current.remotePath === remotePath
        );
      };
      // 连接失效时保留面板绑定：重连产生新 connectionId 后由 App 统一切换上下文。
      // 这里不能清空 sftpContext，否则 cd 跟随会在后续命令上持续被连接校验拦截。
      if (String(e).includes("connection not found")) {
        if (isCurrent()) {
          set({
            remoteItems: [],
            remoteLoading: false,
            remoteError: String(e),
          });
        }
        return;
      }
      // 其他失败（权限、超时、后端 SFTP 错误等）：保留具体错误信息供面板展示
      if (isCurrent()) {
        set({ remoteItems: [], remoteLoading: false, remoteError: String(e) });
      }
    }
  },
  openRemoteDir: async (item) => {
    if (!item.isDir) return;
    set({ remotePath: item.path, remoteSelected: null });
    await get().loadRemote();
  },
  upRemote: async () => {
    set({ remotePath: dirname(get().remotePath), remoteSelected: null });
    await get().loadRemote();
  },
  syncRemoteCwd: async (command, connectionId, shellId) => {
    const intent = parseCdIntent(command);
    if (!intent) return;
    const seq = (cwdSyncSeq.get(shellId) ?? 0) + 1;
    cwdSyncSeq.set(shellId, seq);
    const isCurrent = () => cwdSyncSeq.get(shellId) === seq;

    const initial = get();
    if (initial.sftpContext?.connectionId !== connectionId) {
      console.warn("[cwd] skip: SFTP context mismatch", {
        connectionId,
        sftpContext: initial.sftpContext?.connectionId,
        command,
      });
      return;
    }

    let home = initial.remoteHomes[connectionId] ?? "";
    const hasShellCwd = !!initial.shellCwds[shellId];
    const baseNeedsHome =
      intent.needsHome || (!hasShellCwd && !intent.target.startsWith("/"));
    if (!home && baseNeedsHome) {
      try {
        home = await ipc.sftpCwd(connectionId);
        set((s) => ({
          remoteHomes: { ...s.remoteHomes, [connectionId]: home },
        }));
      } catch {
        return;
      }
      if (!isCurrent()) return;
    }

    const current = get();
    if (current.sftpContext?.connectionId !== connectionId) return;
    const base = current.shellCwds[shellId] ?? (home || current.remotePath);
    const target = resolveCdTarget(intent, base, home);
    if (!target) return;
    let resolved: string | null = null;
    try {
      const canonical = await ipc.sftpCanonicalDir(connectionId, target);
      // 保留用户实际输入的逻辑路径：符号链接下 cd .. 才能与 shell 的 PWD 一致。
      resolved = canonical ? normalizeRemotePath(target) : null;
    } catch (e) {
      // 兼容尚未重启的 dev 后端：旧进程没有 sftp_canonical_dir，
      // 用现有 sftp_list 校验目标是否为可读目录。
      console.warn("[cwd] canonical command unavailable, fallback to list", {
        target,
        error: e,
      });
      try {
        await ipc.sftpList(connectionId, target);
        resolved = normalizeRemotePath(target);
      } catch (e2) {
        console.warn("[cwd] fallback list failed", { command, target, error: e2 });
        return;
      }
    }
    if (!isCurrent()) return;
    try {
      const latest = get();
      if (latest.sftpContext?.connectionId !== connectionId || !resolved) {
        if (!resolved) {
          console.debug("[cwd] target is not a directory", { command, target });
        }
        return;
      }
      const pathChanged = latest.remotePath !== resolved;
      const shellChanged = latest.shellCwds[shellId] !== resolved;
      const savedChanged = latest.remotePaths[connectionId] !== resolved;
      if (!pathChanged && !shellChanged && !savedChanged) return;

      console.debug("[cwd] resolved", { command, target, resolved, pathChanged });
      set({
        remotePath: resolved,
        remotePaths: {
          ...latest.remotePaths,
          [connectionId]: resolved,
        },
        shellCwds: {
          ...latest.shellCwds,
          [shellId]: resolved,
        },
        ...(pathChanged ? { remoteSelected: null } : {}),
      });
      if (pathChanged) await get().loadRemote();
    } catch (e) {
      console.warn("[cwd] resolve failed", { command, target, error: e });
      // cd 可能失败、目标不是目录或包含无法解析的 shell 展开，静默保持当前目录
    }
  },
  selectRemote: (item) => set({ remoteSelected: item }),
  invalidateRemoteCache: () => set({ remoteCache: {} }),
  toggleSftpCollapsed: () =>
    set((s) => {
      const next = !s.sftpCollapsed;
      saveSettings({ ...loadSettings(), sftpCollapsed: next });
      return { sftpCollapsed: next };
    }),
  setRightPanelExpanded: (open) => set({ rightPanelExpanded: open }),
  setTransferWindowOpen: (open) => set({ transferWindowOpen: open }),
  setCommandInputOpen: (open) => set({ commandInputOpen: open }),
  toggleBroadcastInput: () =>
    set((s) => {
      const next = !s.broadcastInput;
      saveSettings({ ...loadSettings(), broadcastInput: next });
      return { broadcastInput: next };
    }),
  requestReconnect: (tabId) =>
    set((s) => ({
      reconnectNonce: { ...s.reconnectNonce, [tabId]: (s.reconnectNonce[tabId] ?? 0) + 1 },
    })),
}));

// Derived: filtered sessions by keyword
export function selectFilteredSessions(state: AppState): Session[] {
  const kw = state.searchKeyword.trim().toLowerCase();
  if (!kw) return state.sessions;
  return state.sessions.filter(
    (s) =>
      s.name.toLowerCase().includes(kw) ||
      s.host.toLowerCase().includes(kw) ||
      s.username.toLowerCase().includes(kw)
  );
}
