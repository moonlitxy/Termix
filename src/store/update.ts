import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { UpdateInfo, UpdateProgressEvent } from "../types";

/** 用户选择「忽略此版本」时记录的版本号（localStorage，避免每次启动重复打扰） */
const SKIP_KEY = "termix.skippedUpdateVersion";

function getSkipped(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

interface UpdateState {
  info: UpdateInfo | null;
  checking: boolean;
  dialogOpen: boolean;
  downloading: boolean;
  /** 下载进度（0-100） */
  progress: number;
  /** 下载完成后的安装包路径（用于打开安装程序） */
  downloadedPath: string | null;
  error: string | null;

  /** 启动时自动检查：有新版本且未被忽略时弹出提示 */
  autoCheck: () => Promise<void>;
  /** 检查更新（设置页手动触发），返回结果供调用方展示 */
  check: () => Promise<UpdateInfo | null>;
  openDialog: () => void;
  closeDialog: () => void;
  download: () => Promise<void>;
  setProgress: (e: UpdateProgressEvent) => void;
  setDownloadDone: (path: string) => void;
  setDownloadError: (msg: string) => void;
  skip: (version: string) => void;
}

export const useUpdate = create<UpdateState>((set, get) => ({
  info: null,
  checking: false,
  dialogOpen: false,
  downloading: false,
  progress: 0,
  downloadedPath: null,
  error: null,

  check: async () => {
    set({ checking: true, error: null });
    try {
      const info = await ipc.checkUpdate();
      set({ info, checking: false });
      return info;
    } catch (e) {
      set({ checking: false, error: String(e) });
      return null;
    }
  },

  autoCheck: async () => {
    const info = await get().check();
    if (info?.hasUpdate && info.latestVersion !== getSkipped()) {
      set({ dialogOpen: true });
    }
  },

  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),

  download: async () => {
    const info = get().info;
    if (!info?.hasUpdate || !info.assetUrl) return;
    set({ downloading: true, progress: 0, downloadedPath: null, error: null });
    try {
      await ipc.downloadUpdate(info.assetUrl, info.assetName);
    } catch (e) {
      set({ downloading: false, error: String(e) });
    }
  },

  setProgress: (e) => set({ downloading: true, progress: e.percent }),

  setDownloadDone: (path) =>
    set({ downloading: false, progress: 100, downloadedPath: path }),

  setDownloadError: (msg) =>
    set({ downloading: false, error: msg, downloadedPath: null }),

  skip: (version) => {
    try {
      localStorage.setItem(SKIP_KEY, version);
    } catch {
      // ignore
    }
    set({ dialogOpen: false });
  },
}));
