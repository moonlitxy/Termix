import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp, joinPath } from "../store/app";
import { ipc, onTransferProgress, HISTORY_CHANGED_EVENT } from "../lib/ipc";
import { sftpContextMenu, type SftpMenuItem } from "../lib/sftpMenu";
import { terminalRegistry } from "../lib/terminalRegistry";
import { applyVariables, buildVarDefs } from "../lib/variables";
import type { SftpItem, Snippet } from "../types";

function formatSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function formatMtime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 权限数值 → 符号模式（rwxr-xr-x；setuid 等特殊位省略展示） */
function formatPerms(perms?: number, isDir = false): string {
  if (perms === undefined) return "-";
  const mode = perms & 0o7777;
  let out = isDir ? "d" : "-";
  for (let i = 2; i >= 0; i--) {
    out += (mode >> (i * 3)) & 4 ? "r" : "-";
    out += (mode >> (i * 3)) & 2 ? "w" : "-";
    out += (mode >> (i * 3)) & 1 ? "x" : "-";
  }
  return out;
}

/** 用户/用户组：优先显示名称（root/root），无映射时回退数值 uid/gid */
function formatOwner(it: SftpItem): string {
  const u =
    it.userName ?? (it.uid !== undefined ? String(it.uid) : null);
  const g =
    it.groupName ?? (it.gid !== undefined ? String(it.gid) : null);
  if (u === null && g === null) return "-";
  return `${u ?? "-"}/${g ?? "-"}`;
}

/**
 * 估算文本渲染宽度。
 * - CJK 方块字宽度 ≈ 1em（等于字号）；
 * - ASCII 字符：等宽字体 ≈ 0.6em，比例字体 ≈ 0.55em。
 * 各列字号不同（文件名 body-md≈14px，数据列 body-xs≈12px），
 * 需按列传入实际字号，避免统一系数导致中文长名被低估而截断。
 */
function textWidth(s: string, fontSize: number, mono = false): number {
  const ascii = fontSize * (mono ? 0.6 : 0.55);
  let w = 0;
  for (const ch of s) {
    w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? fontSize : ascii;
  }
  return w;
}

type SortKey = "name" | "size" | "mtime" | "perms" | "uid";
type SortDir = "asc" | "desc";

function cmpField(a: SftpItem, b: SftpItem, key: SortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    case "size":
      return a.size - b.size;
    case "mtime":
      return a.mtime - b.mtime;
    case "perms":
      return (a.perms ?? -1) - (b.perms ?? -1);
    case "uid":
      return (a.uid ?? -1) - (b.uid ?? -1);
  }
}

// ---- 列宽（分隔线拖动调整 / 内容自适应） ----

type ColKey = "name" | "size" | "type" | "mtime" | "perms" | "owner";

const COL_MIN: Record<ColKey, number> = {
  name: 140,
  size: 56,
  type: 40,
  // 修改时间"2026-08-15 14:30"（16 个等宽字符）与权限"drwxr-xr-x"（10 字符）
  // 必须完整显示，最小宽度按内容 + cell 内边距/边框计算，不足时横向滚动而非截断
  mtime: 128,
  perms: 86,
  owner: 64,
};

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  name: 220,
  size: 64,
  type: 44,
  mtime: 128,
  perms: 86,
  owner: 80,
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 根据当前目录内容估算各列合理宽度（按列实际字号估算渲染宽度 + 内边距/图标留白） */
function autoFitCols(items: SftpItem[]): Record<ColKey, number> {
  // 文件名列 body-md≈14px，其余数据列 body-xs≈12px；时间/权限为等宽字体
  const NAME_FS = 14;
  const CELL_FS = 12;
  // 数据列 cell 自带 padding-right 8px + border-right 1px，
  // 文本宽度需在此基础上补偿，否则按内容估算的列宽会被内边距挤压而截断
  const CELL_PAD = 14;
  let nameW = 76;
  let sizeW = 40;
  let mtimeW = 76;
  let permsW = 40;
  let ownerW = 56;
  for (const it of items) {
    nameW = Math.max(nameW, textWidth(it.name, NAME_FS) + 30);
    sizeW = Math.max(sizeW, textWidth(formatSize(it.size), CELL_FS) + CELL_PAD);
    mtimeW = Math.max(mtimeW, textWidth(formatMtime(it.mtime), CELL_FS, true) + CELL_PAD);
    permsW = Math.max(permsW, textWidth(formatPerms(it.perms, it.isDir), CELL_FS, true) + CELL_PAD);
    ownerW = Math.max(ownerW, textWidth(formatOwner(it), CELL_FS) + CELL_PAD);
  }
  return {
    name: clamp(nameW, COL_MIN.name, 480),
    size: clamp(sizeW, COL_MIN.size, 96),
    type: 44,
    mtime: clamp(mtimeW, COL_MIN.mtime, 150),
    perms: clamp(permsW, COL_MIN.perms, 92),
    owner: clamp(ownerW, COL_MIN.owner, 130),
  };
}

/** 排序指示：上下双箭头，当前方向高亮 */
function SortArrows({ state }: { state: "asc" | "desc" | "none" }) {
  return (
    <span className="sftp-sort">
      <Icon
        name="arrow-up"
        size={7}
        className={"sftp-sort__arrow" + (state === "asc" ? " is-active" : "")}
      />
      <Icon
        name="arrow-down"
        size={7}
        className={"sftp-sort__arrow" + (state === "desc" ? " is-active" : "")}
      />
    </span>
  );
}

interface QuickCmdEditing {
  title: string;
  command: string;
  vars: { name: string; defaultValue: string }[];
  values: Record<string, string>;
}

export function SftpView() {
  const sftpContext = useApp((s) => s.sftpContext);
  const remotePath = useApp((s) => s.remotePath);
  const remoteItems = useApp((s) => s.remoteItems);
  const remoteSelected = useApp((s) => s.remoteSelected);
  const remoteLoading = useApp((s) => s.remoteLoading);
  const remoteError = useApp((s) => s.remoteError);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const sftpCollapsed = useApp((s) => s.sftpCollapsed);
  const toggleSftpCollapsed = useApp((s) => s.toggleSftpCollapsed);

  const [remoteDraft, setRemoteDraft] = useState(remotePath);
  const [dropHover, setDropHover] = useState(false);
  const hoverRef = useRef(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "name",
    dir: "asc",
  });
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    item: SftpItem | null;
  } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  // 新建菜单（新建文件夹 / 新建文件）
  const [newMenu, setNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  // 列宽：未手动调整时按内容自适应
  const [colWidths, setColWidths] = useState<Record<ColKey, number> | null>(null);
  const customized = useRef(false);

  // 终端内搜索（Ctrl+F / 右键查找）
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // 快捷命令（原工具栏合并）
  const [cmdOpen, setCmdOpen] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdEditing, setCmdEditing] = useState<QuickCmdEditing | null>(null);
  const cmdSearchRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // 排序（目录始终优先分组，组内按所选字段升/降序）
  const sortedItems = useMemo(() => {
    const arr = [...remoteItems];
    arr.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const r = cmpField(a, b, sort.key);
      return sort.dir === "asc" ? r : -r;
    });
    return arr;
  }, [remoteItems, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" }
    );
  };

  // 右键菜单：点击外部 / Esc 关闭
  useEffect(() => {
    if (!ctx) return;
    const onDocClick = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtx(null);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtx(null);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [ctx]);

  // 新建菜单：点击外部 / Esc 关闭
  useEffect(() => {
    if (!newMenu) return;
    const onDocClick = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenu(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNewMenu(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [newMenu]);

  const copyPath = async (p: string) => {
    try {
      await navigator.clipboard.writeText(p);
    } catch (e) {
      console.error("[sftp] copy path failed:", e);
    }
  };

  // 右键菜单项分发
  const runMenuAction = (m: SftpMenuItem) => {
    if (!ctx) return;
    const item = ctx.item;
    switch (m.id) {
      case "download":
        if (item) void (item.isDir ? doDownloadDir(item) : doDownload(item));
        break;
      case "rename":
        if (item) void handleRename(item);
        break;
      case "delete":
        if (item) void handleDelete(item);
        break;
      case "copyPath":
        if (item) void copyPath(item.path);
        break;
      case "mkdir":
        void handleMkdir();
        break;
      case "refresh":
        handleRefresh();
        break;
    }
    setCtx(null);
  };

  useEffect(() => {
    setRemoteDraft(remotePath);
  }, [remotePath]);

  // 文件面板会话跟随连接状态：
  // - 绑定的连接已断开/失效（重连后 connectionId 变化、手动断开等）时先自动解除，
  //   避免残留旧 connectionId 导致目录请求持续报 "connection not found" 而列表空白；
  // - 无上下文且存在已连接会话时自动建立。
  useEffect(() => {
    const st = useApp.getState();
    if (
      st.sftpContext &&
      !st.tabs.some(
        (t) =>
          t.connectionId === st.sftpContext!.connectionId && t.status === "connected"
      )
    ) {
      st.setSftpContext(st.sftpContext.sessionId, null);
      return;
    }
    if (!st.sftpContext) {
      const conn = st.tabs.find(
        (t) => t.connectionId && t.status === "connected"
      );
      if (conn?.connectionId) {
        void st.setSftpContext(conn.sessionId, conn.connectionId);
      }
    }
  }, [tabs, sftpContext]);

  // 上传任务完成后刷新当前远程目录（先失效缓存再重载）
  useEffect(() => {
    let un: (() => void) | undefined;
    onTransferProgress((e) => {
      if (e.status === "completed") {
        if (e.direction === "upload") {
          useApp.getState().invalidateRemoteCache();
          void useApp.getState().loadRemote();
        }
      }
    })
      .then((u) => {
        un = u;
      })
      .catch(() => {
        /* browser mode */
      });
    return () => {
      un?.();
    };
  }, []);

  // 系统文件拖入（Tauri webview 事件）：拖到远程文件列表视为上传
  useEffect(() => {
    if (!("__TAURI__" in window)) return;
    let un: (() => void) | undefined;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((ev) => {
          const p = ev.payload;
          if (p.type !== "drop" || !p.paths?.length) return;
          console.log("[sftp] system files dropped:", p.paths, "onPane:", hoverRef.current);
          const st = useApp.getState();
          if (!st.sftpContext) {
            window.alert("请先连接一个 SSH 会话，再拖拽文件上传");
            return;
          }
          if (!hoverRef.current) {
            window.alert("请将文件拖到远程文件列表中上传");
            return;
          }
          const failures: string[] = [];
          const ctx = st.sftpContext;
          const uploads = p.paths.map((path) => {
            const name = path.split(/[\\/]/).pop() || path;
            const dest = joinPath(st.remotePath, name);
            return ipc
              .sftpUpload(ctx.connectionId, ctx.sessionId, path, dest)
              .then((tid) => console.log("[sftp] system upload task started:", tid))
              .catch((e) => {
                console.error("[sftp] system upload failed:", path, e);
                failures.push(`${name}: ${String(e)}`);
              });
          });
          void Promise.all(uploads).then(() => {
            if (failures.length > 0) {
              window.alert(`有 ${failures.length} 个文件上传失败：\n${failures.join("\n")}`);
            }
          });
        })
      )
      .then((u) => {
        un = u;
      })
      .catch((e) => console.warn("[sftp] drag-drop listener unavailable:", e));
    return () => {
      un?.();
    };
  }, []);

  // 搜索入口：Ctrl+F 与终端右键「查找」统一触发
  useEffect(() => {
    const onSearch = () => {
      setSearchOpen(true);
      setTimeout(() => searchRef.current?.focus(), 30);
    };
    document.addEventListener("termix:search", onSearch);
    return () => document.removeEventListener("termix:search", onSearch);
  }, []);

  // 列宽自适应：目录内容加载后按内容估算（用户手动调整过则不再覆盖）
  useEffect(() => {
    if (customized.current || remoteItems.length === 0) return;
    setColWidths(autoFitCols(remoteItems));
  }, [remoteItems]);

  // ---- 终端联动操作（原工具栏合并） ----

  const doFind = (dir: "next" | "prev") => {
    const targetId = terminalRegistry.getFocus() ?? activeTabId;
    const s = targetId ? terminalRegistry.getSearch(targetId) : undefined;
    if (!s || !query) return;
    if (dir === "next") s.findNext(query, { caseSensitive: false });
    else s.findPrevious(query, { caseSensitive: false });
  };

  const handleClearTerminal = () => {
    const id = activeTabId;
    const t = id ? terminalRegistry.get(id) : undefined;
    if (t && id) {
      t.clear();
      t.clearSelection();
      terminalRegistry.clearBuffer(id);
      t.focus();
    }
  };

  // ---- 快捷命令 ----

  const sendCommand = async (command: string) => {
    if (!activeTab?.connectionId || !activeTab.shellId) {
      window.alert("请先打开一个已连接的终端标签页");
      return;
    }
    try {
      await ipc.terminalWrite(activeTab.connectionId, activeTab.shellId, command + "\n");
      // 快捷命令同样写入历史，与终端直接输入/底部输入框保持同一份历史
      if (activeTab.sessionId) {
        await ipc.historyAdd(activeTab.sessionId, command);
        document.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT));
      }
    } catch (e) {
      console.error("[quick-cmd] send failed:", e);
    }
  };

  const toggleQuickCmd = async () => {
    const next = !cmdOpen;
    setCmdOpen(next);
    setCmdEditing(null);
    setCmdQuery("");
    if (next) {
      try {
        setSnippets(await ipc.snippetList());
      } catch {
        setSnippets([]);
      }
      setTimeout(() => cmdSearchRef.current?.focus(), 30);
    }
  };

  const runSnippet = async (s: Snippet) => {
    // 含 {{var}} 占位符时先让用户填写变量
    const vars = buildVarDefs(s.command, s.variables);
    if (vars.length > 0) {
      setCmdEditing({
        title: s.title,
        command: s.command,
        vars,
        values: Object.fromEntries(vars.map((v) => [v.name, v.defaultValue])),
      });
      return;
    }
    setCmdOpen(false);
    await sendCommand(s.command);
  };

  const confirmQuickCmd = async () => {
    if (!cmdEditing) return;
    const cmd = applyVariables(cmdEditing.command, cmdEditing.values);
    setCmdEditing(null);
    setCmdOpen(false);
    await sendCommand(cmd);
  };

  const filteredSnippets = cmdQuery.trim()
    ? snippets.filter(
        (s) => s.title.includes(cmdQuery.trim()) || s.command.includes(cmdQuery.trim())
      )
    : snippets;

  // ---- 文件操作 ----

  const doDownload = async (remote: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) {
      window.alert("请先连接一个 SSH 会话，再下载文件");
      return;
    }
    const dest = joinPath(st.localPath, remote.name);
    // 防呆：本地目标目录已存在同名文件时确认覆盖，避免静默覆盖本地数据
    if (st.localPath) {
      try {
        const list = await ipc.localList(st.localPath);
        if (list.some((f) => f.name === remote.name && !f.isDir)) {
          if (
            !window.confirm(
              `本地已存在同名文件 ${remote.name}，是否覆盖？`
            )
          ) {
            return;
          }
        }
      } catch {
        /* 本地目录不可读时不拦截，交由下载任务处理 */
      }
    }
    console.log("[sftp] download", { remote: remote.path, local: dest, conn: st.sftpContext.connectionId });
    try {
      const taskId = await ipc.sftpDownload(
        st.sftpContext.connectionId,
        st.sftpContext.sessionId,
        remote.path,
        dest
      );
      console.log("[sftp] download task started:", taskId);
    } catch (e) {
      console.error("[sftp] download failed:", e);
      window.alert(`下载 ${remote.name} 失败：${String(e)}`);
    }
  };

  const doDownloadDir = async (remote: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) {
      window.alert("请先连接一个 SSH 会话，再下载目录");
      return;
    }
    const dest = joinPath(st.localPath, remote.name);
    // 防呆：本地已存在同名目录时提示（下载内容将合并进入该目录）
    if (st.localPath) {
      try {
        const list = await ipc.localList(st.localPath);
        if (list.some((f) => f.name === remote.name && f.isDir)) {
          if (
            !window.confirm(
              `本地已存在同名目录 ${remote.name}，下载内容将合并到其中，是否继续？`
            )
          ) {
            return;
          }
        }
      } catch {
        /* 本地目录不可读时不拦截 */
      }
    }
    console.log("[sftp] download-dir", { remote: remote.path, local: dest, conn: st.sftpContext.connectionId });
    try {
      const taskId = await ipc.sftpDownloadDir(
        st.sftpContext.connectionId,
        st.sftpContext.sessionId,
        remote.path,
        dest
      );
      console.log("[sftp] download-dir task started:", taskId);
    } catch (e) {
      console.error("[sftp] download-dir failed:", e);
      window.alert(`下载目录 ${remote.name} 失败：${String(e)}`);
    }
  };

  const handleOpen = (item: SftpItem) => {
    const st = useApp.getState();
    if (item.isDir) {
      void st.openRemoteDir(item);
    } else {
      void doDownload(item);
    }
  };

  // 刷新：失效缓存后强制重新拉取。
  // 节流保护：加载失败后连续点击重试/刷新时，仅首个点击立即发起请求，
  // 短窗口内的重复点击直接忽略（loadRemote 另有 in-flight 并发保护兜底）
  const lastRefreshAt = useRef(0);
  const handleRefresh = () => {
    const now = Date.now();
    if (now - lastRefreshAt.current < 600) return;
    lastRefreshAt.current = now;
    const st = useApp.getState();
    st.invalidateRemoteCache();
    void st.loadRemote();
  };

  const handleMkdir = async () => {
    const st = useApp.getState();
    if (!st.sftpContext) return;
    const name = window.prompt("新建文件夹名称");
    if (!name) return;
    try {
      await ipc.sftpMkdir(st.sftpContext.connectionId, joinPath(st.remotePath, name));
      st.invalidateRemoteCache();
      void st.loadRemote();
    } catch (e) {
      window.alert(String(e));
    }
  };

  // 新建（文件夹/文件）：创建默认名后立即进入重命名状态引导命名（取消则保留默认名）
  const handleCreate = async (kind: "dir" | "file") => {
    const st = useApp.getState();
    if (!st.sftpContext) return;
    setNewMenu(false);
    const defaultName = kind === "dir" ? "新建文件夹" : "新建文件.txt";
    const target = joinPath(st.remotePath, defaultName);
    try {
      if (kind === "dir") {
        await ipc.sftpMkdir(st.sftpContext.connectionId, target);
      } else {
        await ipc.sftpCreateFile(st.sftpContext.connectionId, target);
      }
      st.invalidateRemoteCache();
      await st.loadRemote();
      const name = window.prompt(
        kind === "dir" ? "文件夹名称" : "文件名称",
        defaultName
      );
      if (name && name.trim() && name.trim() !== defaultName) {
        const newPath = joinPath(st.remotePath, name.trim());
        try {
          await ipc.sftpRename(st.sftpContext.connectionId, target, newPath);
          st.invalidateRemoteCache();
          void st.loadRemote();
        } catch (e) {
          window.alert(`重命名失败：${String(e)}`);
        }
      }
    } catch (e) {
      window.alert(String(e));
    }
  };

  const handleDelete = async (item: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) return;
    // 防呆：删除不可恢复；目录删除会递归删除全部内容，需明确警示
    const msg = item.isDir
      ? `删除目录 ${item.name}？\n目录及其内所有内容将被永久删除，此操作不可恢复。`
      : `删除文件 ${item.name}？此操作不可恢复。`;
    if (!window.confirm(msg)) return;
    try {
      await ipc.sftpRemove(st.sftpContext.connectionId, item.path, item.isDir);
      st.invalidateRemoteCache();
      void st.loadRemote();
    } catch (e) {
      window.alert(String(e));
    }
  };

  const handleRename = async (item: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) return;
    const name = window.prompt("新名称", item.name);
    if (!name || name === item.name) return;
    const newPath = joinPath(item.path.replace(/\/[^/]+$/, ""), name);
    try {
      await ipc.sftpRename(st.sftpContext.connectionId, item.path, newPath);
      st.invalidateRemoteCache();
      void st.loadRemote();
    } catch (e) {
      window.alert(String(e));
    }
  };

  // ---- 列宽拖动 ----

  const startResize = (e: React.PointerEvent, col: ColKey) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = (colWidths ?? DEFAULT_WIDTHS)[col];
    customized.current = true;
    const move = (ev: PointerEvent) => {
      const w = Math.max(COL_MIN[col], startW + (ev.clientX - startX));
      setColWidths((p) => ({ ...(p ?? DEFAULT_WIDTHS), [col]: w }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!sftpContext) {
    // 有连接在途（正在连接 / 已连接但文件会话尚未建立）时显示加载中，
    // 避免点击连接后文件区一直空白直到目录就绪
    const pending = tabs.some(
      (t) =>
        t.status === "connecting" ||
        (t.status === "connected" && !!t.connectionId)
    );
    return (
      <div className="workspace__empty">
        <span className="workspace__empty-logo">
          <Icon name="folder" size={56} />
        </span>
        <div className="workspace__empty-text">
          {pending ? "加载中…" : "连接会话后查看远程文件"}
        </div>
        <div className="workspace__empty-sub">
          {pending
            ? "正在建立文件会话并读取远程目录"
            : "在左侧双击会话建立 SSH 连接，此处将展示远程文件系统"}
        </div>
      </div>
    );
  }

  const widths = colWidths ?? DEFAULT_WIDTHS;
  const colVars = {
    "--sftp-name": widths.name + "px",
    "--sftp-size": widths.size + "px",
    "--sftp-type": widths.type + "px",
    "--sftp-mtime": widths.mtime + "px",
    "--sftp-perms": widths.perms + "px",
    "--sftp-owner": widths.owner + "px",
  } as React.CSSProperties;

  const sortState = (key: SortKey): "asc" | "desc" | "none" =>
    sort.key === key ? sort.dir : "none";

  return (
    <div className="sftp-view">
      <div className="sftp-toolbar">
        <span className="sftp-toolbar__session">
          <Icon name="folder" size={13} />文件
        </span>
        <div className="sftp-pathbar">
          <button
            className="ds-btn ds-btn--tertiary ds-btn--sm"
            type="button"
            title="上级目录"
            onClick={() => void useApp.getState().upRemote()}
          >
            <Icon name="arrow-up" size={12} />
          </button>
          <input
            className="sftp-pathbar__input"
            value={remoteDraft}
            onChange={(e) => setRemoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                useApp.setState({ remotePath: remoteDraft });
                useApp.getState().invalidateRemoteCache();
                void useApp.getState().loadRemote();
              }
            }}
            spellCheck={false}
          />
        </div>
        <div className="sftp-toolbar__actions">
          <button
            className="ds-btn ds-btn--secondary ds-btn--sm"
            type="button"
            title="快捷命令：打开已保存的命令片段并发送到终端"
            onClick={() => void toggleQuickCmd()}
          >
            <Icon name="terminal" size={12} />快捷命令
          </button>
          <button
            className="ds-btn ds-btn--secondary ds-btn--sm"
            type="button"
            title="清屏：清空当前终端输出"
            onClick={handleClearTerminal}
          >
            <Icon name="trash" size={12} />清屏
          </button>
          <button
            className="ds-btn ds-btn--secondary ds-btn--sm"
            type="button"
            title="刷新：重新加载当前远程目录"
            onClick={handleRefresh}
          >
            <Icon name="refresh" size={12} />刷新
          </button>
          <span className="sftp-new-wrap">
            <button
              className="ds-btn ds-btn--secondary ds-btn--sm"
              type="button"
              title="新建：创建远程文件夹或文件"
              onClick={() => setNewMenu((v) => !v)}
            >
              <Icon name="plus" size={12} />新建
            </button>
            {newMenu && (
              <>
                <div
                  className="sftp-new-backdrop"
                  onClick={() => setNewMenu(false)}
                />
                <div className="ctx-menu sftp-new-menu" ref={newMenuRef}>
                  <button
                    type="button"
                    className="ctx-menu__item"
                    title="在远程目录创建文件夹"
                    onClick={() => void handleCreate("dir")}
                  >
                    <Icon name="folder" size={12} />新建文件夹
                  </button>
                  <button
                    type="button"
                    className="ctx-menu__item"
                    title="在远程目录创建文件"
                    onClick={() => void handleCreate("file")}
                  >
                    <Icon name="file" size={12} />新建文件
                  </button>
                </div>
              </>
            )}
          </span>
          {remoteSelected && !remoteSelected.isDir && (
            <button
              className="ds-btn ds-btn--secondary ds-btn--sm"
              type="button"
              title="下载：将选中的远程文件下载到本地（目录下载请使用右键菜单）"
              onClick={() => void doDownload(remoteSelected)}
            >
              <Icon name="download" size={12} />下载
            </button>
          )}
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title={
              sftpCollapsed
                ? "展开面板：显示远程文件列表（文件名、大小、类型、修改时间、权限、用户/组）"
                : "收起面板：隐藏文件列表，仅保留工具栏条"
            }
            onClick={toggleSftpCollapsed}
          >
            <Icon name={sftpCollapsed ? "chevron-up" : "chevron-down"} size={14} />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="toolbar__search sftp-search">
          <input
            ref={searchRef}
            className="ds-input toolbar__search-input"
            value={query}
            placeholder="搜索终端内容…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                doFind(e.shiftKey ? "prev" : "next");
              } else if (e.key === "Escape") {
                setSearchOpen(false);
                setQuery("");
              }
            }}
            spellCheck={false}
          />
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title="上一个"
            onClick={() => doFind("prev")}
          >
            <Icon name="chevron-up" size={13} />
          </button>
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title="下一个"
            onClick={() => doFind("next")}
          >
            <Icon name="chevron-down" size={13} />
          </button>
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title="关闭"
            onClick={() => {
              setSearchOpen(false);
              setQuery("");
            }}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {!sftpCollapsed && (
        <div
          className={"sftp-list sftp-list--remote" + (dropHover ? " is-drop-target" : "")}
          style={colVars}
          onDragOver={(e) => {
            e.preventDefault();
            hoverRef.current = true;
            setDropHover(true);
          }}
          onDragLeave={() => {
            hoverRef.current = false;
            setDropHover(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            hoverRef.current = false;
            setDropHover(false);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtx({ x: e.clientX, y: e.clientY, item: null });
          }}
        >
          <div className="sftp-head">
            <button
              type="button"
              className={
                "sftp-head__cell" + (sort.key === "name" ? " is-sorted" : "")
              }
              title="按名称排序"
              onClick={() => toggleSort("name")}
            >
              文件名<SortArrows state={sortState("name")} />
              <span
                className="sftp-resizer"
                onPointerDown={(e) => startResize(e, "name")}
              />
            </button>
            <button
              type="button"
              className={
                "sftp-head__cell" + (sort.key === "size" ? " is-sorted" : "")
              }
              title="按大小排序"
              onClick={() => toggleSort("size")}
            >
              大小<SortArrows state={sortState("size")} />
              <span
                className="sftp-resizer"
                onPointerDown={(e) => startResize(e, "size")}
              />
            </button>
            <span className="sftp-head__cell">
              类型
              <span
                className="sftp-resizer"
                onPointerDown={(e) => startResize(e, "type")}
              />
            </span>
            <button
              type="button"
              className={
                "sftp-head__cell" + (sort.key === "mtime" ? " is-sorted" : "")
              }
              title="按修改时间排序"
              onClick={() => toggleSort("mtime")}
            >
              修改时间<SortArrows state={sortState("mtime")} />
              <span
                className="sftp-resizer"
                onPointerDown={(e) => startResize(e, "mtime")}
              />
            </button>
            <button
              type="button"
              className={
                "sftp-head__cell" + (sort.key === "perms" ? " is-sorted" : "")
              }
              title="按权限排序"
              onClick={() => toggleSort("perms")}
            >
              权限<SortArrows state={sortState("perms")} />
              <span
                className="sftp-resizer"
                onPointerDown={(e) => startResize(e, "perms")}
              />
            </button>
            <button
              type="button"
              className={
                "sftp-head__cell" + (sort.key === "uid" ? " is-sorted" : "")
              }
              title="按用户/组排序"
              onClick={() => toggleSort("uid")}
            >
              用户/组<SortArrows state={sortState("uid")} />
              <span
                className="sftp-resizer"
                onPointerDown={(e) => startResize(e, "owner")}
              />
            </button>
          </div>
          {remoteLoading && <div className="sftp-empty">加载中…</div>}
          {!remoteLoading &&
            sortedItems.map((it) => (
              <div
                key={it.path}
                className={
                  "sftp-row" + (remoteSelected?.path === it.path ? " is-active" : "")
                }
                onClick={() => useApp.getState().selectRemote(it)}
                onDoubleClick={() => handleOpen(it)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  useApp.getState().selectRemote(it);
                  setCtx({ x: e.clientX, y: e.clientY, item: it });
                }}
                title={it.path}
              >
                <span className="sftp-row__name">
                  <span className="sftp-row__icon">
                    <Icon name={it.isDir ? "folder" : "file"} size={13} />
                  </span>
                  <span className="sftp-row__label">{it.name}</span>
                </span>
                <span className="sftp-row__cell sftp-row__cell--num">
                  {it.isDir && it.size < 5120 ? "—" : formatSize(it.size)}
                </span>
                <span className="sftp-row__cell">
                  {it.isDir ? "目录" : "文件"}
                </span>
                <span className="sftp-row__cell sftp-row__cell--time">
                  {formatMtime(it.mtime)}
                </span>
                <span className="sftp-row__cell sftp-row__cell--perms">
                  {formatPerms(it.perms, it.isDir)}
                </span>
                <span className="sftp-row__cell">
                  {formatOwner(it)}
                </span>
              </div>
            ))}
          {!remoteLoading && remoteError && (
            <div className="sftp-error">
              <span className="sftp-error__icon">
                <Icon name="alert-circle" size={15} />
              </span>
              <div className="sftp-error__body">
                <div className="sftp-error__title">目录加载失败</div>
                <div className="sftp-error__msg" title={remoteError}>
                  {remoteError}
                </div>
              </div>
              <button
                className="ds-btn ds-btn--secondary ds-btn--sm"
                type="button"
                title="重新加载当前远程目录"
                onClick={handleRefresh}
              >
                重试
              </button>
            </div>
          )}
          {!remoteLoading && !remoteError && remoteItems.length === 0 && (
            <div className="sftp-empty">空目录</div>
          )}
          <div className="sftp-pane__hint">可拖拽本地文件到此处上传</div>
        </div>
      )}

      {cmdOpen && (
        <div
          className="toolbar__qc-backdrop"
          onClick={() => {
            setCmdOpen(false);
            setCmdEditing(null);
          }}
        >
          <div className="toolbar__qc-panel" onClick={(e) => e.stopPropagation()}>
            {cmdEditing ? (
              <>
                <div className="toolbar__qc-head">
                  <span className="toolbar__qc-title">填写变量：{cmdEditing.title}</span>
                  <button
                    className="ds-btn ds-btn--tertiary ds-btn--icon"
                    type="button"
                    title="关闭"
                    onClick={() => setCmdEditing(null)}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
                <pre className="toolbar__qc-preview">{cmdEditing.command}</pre>
                {cmdEditing.vars.map((v) => (
                  <div className="form-row" key={v.name}>
                    <label>{v.name}</label>
                    <input
                      className="ds-input"
                      value={cmdEditing.values[v.name] ?? ""}
                      placeholder={`默认: ${v.defaultValue || "（空）"}`}
                      onChange={(e) =>
                        setCmdEditing({
                          ...cmdEditing,
                          values: { ...cmdEditing.values, [v.name]: e.target.value },
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void confirmQuickCmd();
                      }}
                    />
                  </div>
                ))}
                <div className="toolbar__qc-actions">
                  <button
                    className="ds-btn ds-btn--secondary"
                    type="button"
                    title="返回：回到命令列表"
                    onClick={() => setCmdEditing(null)}
                  >
                    返回
                  </button>
                  <button
                    className="ds-btn ds-btn--brand"
                    type="button"
                    title="执行：替换变量后发送命令到终端"
                    onClick={() => void confirmQuickCmd()}
                  >
                    执行
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="toolbar__qc-head">
                  <span className="toolbar__qc-title">快捷命令</span>
                  <button
                    className="ds-btn ds-btn--tertiary ds-btn--icon"
                    type="button"
                    title="关闭快捷命令面板"
                    onClick={() => {
                      setCmdOpen(false);
                      setCmdEditing(null);
                    }}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
                <input
                  ref={cmdSearchRef}
                  className="ds-input toolbar__qc-search"
                  value={cmdQuery}
                  placeholder="搜索命令…"
                  spellCheck={false}
                  onChange={(e) => setCmdQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setCmdOpen(false);
                      setCmdEditing(null);
                    }
                  }}
                />
                <div className="toolbar__qc-list">
                  {filteredSnippets.length === 0 && (
                    <div className="toolbar__qc-empty">
                      暂无匹配的片段，可在“命令片段”中创建
                    </div>
                  )}
                  {filteredSnippets.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="toolbar__qc-item"
                      title={`发送命令：${s.title}`}
                      onClick={() => void runSnippet(s)}
                    >
                      <span className="toolbar__qc-item-title">{s.title}</span>
                      <span className="toolbar__qc-item-cmd">{s.command}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {ctx && (
        <div
          className="ctx-menu"
          ref={ctxRef}
          style={{ left: ctx.x, top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {sftpContextMenu("remote", ctx.item).map((m) => (
            <Fragment key={m.id}>
              {m.dividerBefore && <div className="ctx-menu__sep" />}
              <button
                type="button"
                className={
                  "ctx-menu__item" + (m.dangerous ? " ctx-menu__item--danger" : "")
                }
                title={m.label}
                onClick={() => runMenuAction(m)}
              >
                <Icon name={m.icon} size={12} />
                {m.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
