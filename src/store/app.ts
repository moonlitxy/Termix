import { create } from "zustand";
import type {
  Activity,
  Group,
  Session,
  SftpItem,
  Tab,
  TransferProgressEvent,
  TransferTask,
} from "../types";
import { ipc } from "../lib/ipc";

interface SftpContext {
  sessionId: string;
  connectionId: string;
}

interface AppState {
  sessions: Session[];
  groups: Group[];
  tabs: Tab[];
  activeTabId: string | null;
  searchKeyword: string;
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
  remoteSelected: SftpItem | null;
  /** 本地下载目标目录（无本地文件面板，下载直接落到该目录） */
  localPath: string;
  /** 远程目录列表加载中标记（用于展示加载状态，避免重复触发加载） */
  remoteLoading: boolean;
  /** 远程目录列表缓存：connectionId|path → 条目与时间戳，短 TTL 内复用避免重复请求 */
  remoteCache: Record<string, { items: SftpItem[]; ts: number }>;
  /** SFTP 面板收起状态：收起后仅保留工具栏条 */
  sftpCollapsed: boolean;

  loadSessions: () => Promise<void>;
  loadGroups: () => Promise<void>;
  setSearch: (kw: string) => void;

  addTab: (tab: Tab) => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;

  openNewConnection: (session?: Session, presetGroupId?: string) => void;
  closeNewConnection: () => void;

  setActivity: (a: Activity) => void;
  setTransfers: (list: TransferTask[]) => void;
  upsertTransfer: (e: TransferProgressEvent) => void;
  setSftpContext: (sessionId: string, connectionId: string | null) => Promise<void>;
  loadRemote: () => Promise<void>;
  openRemoteDir: (item: SftpItem) => Promise<void>;
  upRemote: () => Promise<void>;
  selectRemote: (item: SftpItem | null) => void;
  /** 目录变更（新建/重命名/删除/上传完成）后使缓存失效，下次加载强制重新请求 */
  invalidateRemoteCache: () => void;
  /** 切换 SFTP 面板收起/展开状态 */
  toggleSftpCollapsed: () => void;
}

let tabSeq = 0;
export function nextTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now()}-${tabSeq}`;
}

/** 远程目录列表缓存有效期（毫秒） */
const REMOTE_CACHE_TTL = 5000;
/** 远程目录加载 in-flight 集合（key: connectionId|path），防止同路径并发重复请求 */
const inflightRemote = new Set<string>();

export function joinPath(a: string, b: string): string {
  if (!a) return b;
  return a.endsWith("/") ? a + b : a + "/" + b;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i);
}

export const useApp = create<AppState>((set, get) => ({
  sessions: [],
  groups: [],
  tabs: [],
  activeTabId: null,
  searchKeyword: "",
  newConnOpen: false,
  editingSession: null,
  newConnPresetGroupId: null,

  activity: "terminal",
  transfers: [],
  sftpContext: null,
  remoteItems: [],
  remotePath: "/",
  remoteSelected: null,
  localPath: "",
  remoteLoading: false,
  remoteCache: {},
  sftpCollapsed: false,

  loadSessions: async () => {
    try {
      const sessions = await ipc.sessionList();
      set({ sessions });
    } catch (e) {
      console.warn("loadSessions:", e);
    }
  },
  loadGroups: async () => {
    try {
      const groups = await ipc.groupList();
      set({ groups });
    } catch (e) {
      console.warn("loadGroups:", e);
    }
  },
  setSearch: (kw) => set({ searchKeyword: kw }),

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

  setActivity: (a) => {
    set({ activity: a });
    // 进入 SFTP 时：已有终端 SSH 连接则直接建立 SFTP 会话，无需再手动连接
    if (a === "sftp") {
      const st = get();
      if (!st.sftpContext) {
        const conn = st.tabs.find(
          (t) => t.connectionId && t.status === "connected"
        );
        if (conn?.connectionId) {
          void st.setSftpContext(conn.sessionId, conn.connectionId);
        }
      }
    }
  },
  setTransfers: (list) => set({ transfers: list }),
  upsertTransfer: (e) =>
    set((s) => {
      const tasks = [...s.transfers];
      const idx = tasks.findIndex((t) => t.id === e.taskId);
      if (idx >= 0) {
        const t = tasks[idx];
        tasks[idx] = {
          ...t,
          fileName: e.fileName ?? t.fileName,
          direction: (e.direction as "upload" | "download") ?? t.direction,
          status: (e.status as TransferTask["status"]) ?? t.status,
          progress: e.progress ?? t.progress,
          speed: e.speed ?? t.speed,
          error: e.error ?? t.error,
        };
      } else if (e.fileName) {
        tasks.unshift({
          id: e.taskId,
          sessionId: "",
          fileName: e.fileName,
          direction: e.direction === "download" ? "download" : "upload",
          localPath: "",
          remotePath: "",
          status: (e.status as TransferTask["status"]) ?? "running",
          progress: e.progress ?? 0,
          speed: e.speed ?? 0,
          error: e.error,
          isDir: false,
        });
      }
      return { transfers: tasks };
    }),

  setSftpContext: async (sessionId, connectionId) => {
    set({ sftpContext: connectionId ? { sessionId, connectionId } : null });
    if (connectionId) {
      // 初始固定展示根目录 "/"：确保进入 SFTP 时根目录下的文件与文件夹
      // 立即可见，不依赖点击上级目录触发刷新；同时避免复用上一次的残留路径。
      set({ remotePath: "/", remoteSelected: null });
    }
    await get().loadRemote();
  },
  loadRemote: async () => {
    const { sftpContext, remotePath } = get();
    if (!sftpContext) {
      set({ remoteItems: [], remoteLoading: false });
      return;
    }
    const key = `${sftpContext.connectionId}|${remotePath}`;
    // 短 TTL 缓存命中：复用上次结果，避免进入/切换目录时重复发起 SFTP 请求
    const cached = get().remoteCache[key];
    if (cached && Date.now() - cached.ts < REMOTE_CACHE_TTL) {
      set({ remoteItems: cached.items, remoteLoading: false });
      return;
    }
    // 并发保护：同一路径已有请求在途时不再重复发起
    if (inflightRemote.has(key)) return;
    inflightRemote.add(key);
    set({ remoteLoading: true });
    try {
      const items = await ipc.sftpList(sftpContext.connectionId, remotePath);
      inflightRemote.delete(key);
      set((s) => ({
        remoteItems: items,
        remoteLoading: false,
        remoteCache: { ...s.remoteCache, [key]: { items, ts: Date.now() } },
      }));
    } catch (e) {
      inflightRemote.delete(key);
      console.warn("loadRemote:", e);
      set({ remoteItems: [], remoteLoading: false });
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
  selectRemote: (item) => set({ remoteSelected: item }),
  invalidateRemoteCache: () => set({ remoteCache: {} }),
  toggleSftpCollapsed: () => set((s) => ({ sftpCollapsed: !s.sftpCollapsed })),
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
