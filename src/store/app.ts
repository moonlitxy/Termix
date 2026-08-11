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

  // v0.2
  activity: Activity;
  transfers: TransferTask[];
  sftpContext: SftpContext | null;
  remoteItems: SftpItem[];
  localItems: SftpItem[];
  remotePath: string;
  localPath: string;
  remoteSelected: SftpItem | null;
  localSelected: SftpItem | null;

  loadSessions: () => Promise<void>;
  loadGroups: () => Promise<void>;
  setSearch: (kw: string) => void;

  addTab: (tab: Tab) => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;

  openNewConnection: (session?: Session) => void;
  closeNewConnection: () => void;

  setActivity: (a: Activity) => void;
  setTransfers: (list: TransferTask[]) => void;
  upsertTransfer: (e: TransferProgressEvent) => void;
  setSftpContext: (sessionId: string, connectionId: string | null) => void;
  loadRemote: () => Promise<void>;
  loadLocal: () => Promise<void>;
  openRemoteDir: (item: SftpItem) => Promise<void>;
  openLocalDir: (item: SftpItem) => Promise<void>;
  upRemote: () => Promise<void>;
  upLocal: () => Promise<void>;
  selectRemote: (item: SftpItem | null) => void;
  selectLocal: (item: SftpItem | null) => void;
}

let tabSeq = 0;
export function nextTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now()}-${tabSeq}`;
}

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

  activity: "terminal",
  transfers: [],
  sftpContext: null,
  remoteItems: [],
  localItems: [],
  remotePath: "/",
  localPath: "",
  remoteSelected: null,
  localSelected: null,

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

  addTab: (tab) => set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id })),
  setActiveTab: (id) => set({ activeTabId: id }),
  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId;
      return { tabs, activeTabId };
    }),
  updateTab: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  openNewConnection: (session) =>
    set({ newConnOpen: true, editingSession: session ?? null }),
  closeNewConnection: () => set({ newConnOpen: false, editingSession: null }),

  setActivity: (a) => set({ activity: a }),
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
        });
      }
      return { transfers: tasks };
    }),

  setSftpContext: (sessionId, connectionId) => {
    set({ sftpContext: connectionId ? { sessionId, connectionId } : null });
    void get().loadRemote();
  },
  loadRemote: async () => {
    const { sftpContext, remotePath } = get();
    if (!sftpContext) {
      set({ remoteItems: [] });
      return;
    }
    try {
      const items = await ipc.sftpList(sftpContext.connectionId, remotePath);
      set({ remoteItems: items });
    } catch (e) {
      console.warn("loadRemote:", e);
      set({ remoteItems: [] });
    }
  },
  loadLocal: async () => {
    const { localPath } = get();
    if (!localPath) {
      set({ localItems: [] });
      return;
    }
    try {
      const items = await ipc.localList(localPath);
      set({ localItems: items });
    } catch (e) {
      console.warn("loadLocal:", e);
      set({ localItems: [] });
    }
  },
  openRemoteDir: async (item) => {
    if (!item.isDir) return;
    set({ remotePath: item.path, remoteSelected: null });
    await get().loadRemote();
  },
  openLocalDir: async (item) => {
    if (!item.isDir) return;
    set({ localPath: item.path, localSelected: null });
    await get().loadLocal();
  },
  upRemote: async () => {
    set({ remotePath: dirname(get().remotePath), remoteSelected: null });
    await get().loadRemote();
  },
  upLocal: async () => {
    set({ localPath: dirname(get().localPath), localSelected: null });
    await get().loadLocal();
  },
  selectRemote: (item) => set({ remoteSelected: item }),
  selectLocal: (item) => set({ localSelected: item }),
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
