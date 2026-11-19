import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp, joinPath } from "../store/app";
import { ipc, onTransferProgress, HISTORY_CHANGED_EVENT } from "../lib/ipc";
import { sftpContextMenu, type SftpMenuItem } from "../lib/sftpMenu";
import { terminalRegistry } from "../lib/terminalRegistry";
import { applyVariables, buildVarDefs } from "../lib/variables";
import { useClampedMenuPosition } from "../lib/contextMenu";
import { filterItems } from "../lib/fileFilter";
import { rangeSelection, selectAllPaths, toggleSelection } from "../lib/selection";
import { getVirtualRange } from "../lib/virtualList";
import { selectionHint, shouldAutoFit } from "../lib/sftpLayout";
import { pickFunLocalized } from "../lib/fun";
import { getLang, useT } from "../lib/i18n";
import { confirmDialog, promptDialog, toast } from "../store/feedback";
import { LocalFilesPane } from "./LocalFilesPane";
import type { SftpItem, Snippet } from "../types";

function formatSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n < 1024 * 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  return (n / 1024 / 1024 / 1024 / 1024).toFixed(2) + " TB";
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
const SFTP_ROW_HEIGHT = 28;
const SFTP_HEADER_OFFSET = 26;
const SFTP_VIRTUALIZE_THRESHOLD = 80;
const SFTP_OVERSCAN = 8;

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
  const tr = useT();
  const sftpContext = useApp((s) => s.sftpContext);
  const remotePath = useApp((s) => s.remotePath);
  const remoteItems = useApp((s) => s.remoteItems);
  const remoteLoading = useApp((s) => s.remoteLoading);
  const remoteError = useApp((s) => s.remoteError);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const sftpCollapsed = useApp((s) => s.sftpCollapsed);
  const toggleSftpCollapsed = useApp((s) => s.toggleSftpCollapsed);

  const [remoteDraft, setRemoteDraft] = useState(remotePath);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const [dropHover, setDropHover] = useState(false);
  const hoverRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [listViewport, setListViewport] = useState({ scrollTop: 0, height: 0 });
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
  const ctxPosition = useClampedMenuPosition(ctx, ctxRef);
  const menuReturnRef = useRef<HTMLElement | null>(null);
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
  const [localOpen, setLocalOpen] = useState(false);

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
  const filteredItems = useMemo(
    () => filterItems(sortedItems, filterQuery),
    [sortedItems, filterQuery]
  );
  const selectedItems = useMemo(
    () => filteredItems.filter((item) => selectedPaths.includes(item.path)),
    [filteredItems, selectedPaths]
  );

  useEffect(() => {
    setSelectedPaths([]);
    setAnchorPath(null);
  }, [remotePath]);

  useEffect(() => {
    setSelectedPaths([]);
    setAnchorPath(null);
  }, [filterQuery]);

  useEffect(() => {
    setSelectedPaths((paths) =>
      paths.filter((path) => remoteItems.some((item) => item.path === path))
    );
  }, [remoteItems]);

  useEffect(() => {
    if (!sftpContext || sftpCollapsed) return;
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    const syncViewport = () => {
      frame = 0;
      const next = {
        scrollTop: list.scrollTop,
        height: list.clientHeight,
      };
      setListViewport((current) =>
        current.scrollTop === next.scrollTop && current.height === next.height
          ? current
          : next
      );
    };
    const scheduleSync = () => {
      if (!frame) frame = window.requestAnimationFrame(syncViewport);
    };
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(list);
    list.addEventListener("scroll", scheduleSync, { passive: true });
    syncViewport();
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", scheduleSync);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sftpContext, sftpCollapsed]);

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
    const frame = window.requestAnimationFrame(() => {
      ctxRef.current
        ?.querySelector<HTMLElement>("button:not([disabled])")
        ?.focus();
    });
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
      window.cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
      menuReturnRef.current?.focus();
      menuReturnRef.current = null;
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
      toast.success(tr("sftp.pathCopied"));
    } catch (e) {
      console.error("[sftp] copy path failed:", e);
      toast.error(tr("sftp.copyPathFailed"));
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
            toast.warning(tr("sftp.connectFirst"));
            return;
          }
          if (!hoverRef.current) {
            toast.warning(tr("sftp.dropToUpload"));
            return;
          }
          const failures: string[] = [];
          const ctx = st.sftpContext;
          const uploads = p.paths.map(async (path) => {
            const name = path.split(/[\\/]/).pop() || path;
            const dest = joinPath(st.remotePath, name);
            try {
              // 本地目录走目录上传（localList 成功即为目录），文件走单文件上传
              const isDir = await ipc.localList(path).then(
                () => true,
                () => false
              );
              const tid = isDir
                ? await ipc.sftpUploadDir(ctx.connectionId, ctx.sessionId, path, dest)
                : await ipc.sftpUpload(ctx.connectionId, ctx.sessionId, path, dest);
              console.log("[sftp] system upload task started:", tid);
            } catch (e) {
              console.error("[sftp] system upload failed:", path, e);
              failures.push(`${name}: ${String(e)}`);
            }
          });
          void Promise.all(uploads).then(() => {
            if (failures.length > 0) {
              toast.error(
                tr("sftp.uploadFailedN", { n: failures.length, files: failures.join("\n") }),
                tr("sftp.uploadFailedTitle")
              );
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
      const st = useApp.getState();
      if (st.sftpCollapsed) st.toggleSftpCollapsed();
      setSearchOpen(true);
      setTimeout(() => searchRef.current?.focus(), 30);
    };
    document.addEventListener("termix:search", onSearch);
    return () => document.removeEventListener("termix:search", onSearch);
  }, []);

  // 列宽自适应：每个目录首次快速列表到达时估算一次；
  // 后台补充目录大小（enrich）到达时不再重算，避免列宽抖动。
  // 快速加载优先：首屏只等 SFTP read_dir，后台 du/属主信息随后合并。
  const autoFitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${sftpContext?.connectionId ?? "-"}|${remotePath}`;
    if (
      !shouldAutoFit(autoFitKeyRef.current, key, customized.current, remoteItems.length > 0)
    )
      return;
    autoFitKeyRef.current = key;
    setColWidths(autoFitCols(remoteItems));
    // 仅在目录内容首次到达时按内容自适应，后续 enrich 同 key 不再覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteItems, remotePath, sftpContext]);

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
      t.focus();
    }
  };

  // ---- 快捷命令 ----

  const sendCommand = async (command: string) => {
    const connectedTabs = tabs.filter((t) => t.connectionId && t.shellId);
    const target =
      activeTab?.connectionId && activeTab.shellId
        ? activeTab
        : connectedTabs.find(
            (t) => t.connectionId === sftpContext?.connectionId
          ) ?? connectedTabs[0];
    if (!target?.connectionId || !target.shellId) {
      toast.warning(tr("sftp.noConnectedTab"));
      return;
    }
    try {
      useApp.getState().setActiveTab(target.id);
      await ipc.terminalWrite(target.connectionId, target.shellId, command + "\n");
      // 快捷命令同样写入历史，与终端直接输入/底部输入框保持同一份历史
      if (target.sessionId) {
        await ipc.historyAdd(target.sessionId, command);
        document.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT));
      }
      terminalRegistry.focus(target.id);
    } catch (e) {
      console.error("[quick-cmd] send failed:", e);
      toast.error(tr("sftp.sendFailed", { e: String(e) }));
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
      toast.warning(tr("sftp.noSessionDownload"));
      return;
    }
    const downloadDir = st.appPaths?.downloadDir || st.localPath;
    if (!downloadDir) {
      toast.error(tr("sftp.noDownloadDir"));
      return;
    }
    try {
      await ipc.localEnsureDir(downloadDir);
    } catch {
      /* 交给下载任务报错 */
    }
    const dest = joinPath(downloadDir, remote.name);
    // 防呆：本地目标目录已存在同名文件时确认覆盖，避免静默覆盖本地数据
    if (downloadDir) {
      try {
        const list = await ipc.localList(downloadDir);
        if (list.some((f) => f.name === remote.name && !f.isDir)) {
          const confirmed = await confirmDialog({
            title: tr("sftp.overwriteTitle"),
            message: tr("sftp.overwriteMsg", { n: remote.name }),
            confirmText: tr("sftp.overwrite"),
            danger: true,
          });
          if (!confirmed) return;
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
      toast.error(tr("sftp.downloadFailed", { n: remote.name, e: String(e) }));
    }
  };

  const doDownloadDir = async (remote: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) {
      toast.warning(tr("sftp.noSessionDownloadDir"));
      return;
    }
    const downloadDir = st.appPaths?.downloadDir || st.localPath;
    if (!downloadDir) {
      toast.error(tr("sftp.noDownloadDir"));
      return;
    }
    try {
      await ipc.localEnsureDir(downloadDir);
    } catch {
      /* 交给下载任务报错 */
    }
    const dest = joinPath(downloadDir, remote.name);
    // 防呆：本地已存在同名目录时提示（下载内容将合并进入该目录）
    if (downloadDir) {
      try {
        const list = await ipc.localList(downloadDir);
        if (list.some((f) => f.name === remote.name && f.isDir)) {
          const confirmed = await confirmDialog({
            title: tr("sftp.mergeTitle"),
            message: tr("sftp.mergeMsg", { n: remote.name }),
            confirmText: tr("sftp.mergeGo"),
          });
          if (!confirmed) return;
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
      toast.error(tr("sftp.downloadDirFailed", { n: remote.name, e: String(e) }));
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

  const handleRowClick = (
    item: SftpItem,
    modifiers: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }
  ) => {
    if (modifiers.shiftKey) {
      setSelectedPaths(rangeSelection(filteredItems, anchorPath, item.path));
    } else if (modifiers.metaKey || modifiers.ctrlKey) {
      setSelectedPaths((paths) => toggleSelection(paths, item.path));
      setAnchorPath(item.path);
    } else {
      setSelectedPaths([item.path]);
      setAnchorPath(item.path);
    }
    useApp.getState().selectRemote(item);
  };

  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelectedPaths(selectAllPaths(filteredItems));
      return;
    }
    if (e.key === "Escape") {
      setSelectedPaths([]);
      setAnchorPath(null);
    }
  };

  const clearSelection = () => {
    setSelectedPaths([]);
    setAnchorPath(null);
    useApp.getState().selectRemote(null);
  };

  const copySelectedPaths = async () => {
    const paths = selectedItems.map((item) => item.path);
    if (paths.length === 0) return;
    try {
      await navigator.clipboard.writeText(paths.join("\n"));
      toast.success(tr("sftp.copiedN", { n: paths.length }));
    } catch {
      toast.error(tr("sftp.copyPathFailed"));
    }
  };

  const downloadSelected = async () => {
    if (selectedItems.length === 0) return;
    for (const item of selectedItems) {
      if (item.isDir) await doDownloadDir(item);
      else await doDownload(item);
    }
  };

  const deleteSelected = async () => {
    if (!sftpContext || selectedItems.length === 0) return;
    const dirCount = selectedItems.filter((item) => item.isDir).length;
    const confirmed = await confirmDialog({
      title: tr("sftp.batchDeleteTitle"),
      message:
        tr("sftp.batchDeleteMsg", { n: selectedItems.length }) +
        (dirCount > 0 ? tr("sftp.batchDeleteDirs", { n: dirCount }) : "") +
        tr("sftp.irreversible"),
      confirmText: tr("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    const failures: string[] = [];
    for (const item of selectedItems) {
      try {
        await ipc.sftpRemove(sftpContext.connectionId, item.path, item.isDir);
      } catch (e) {
        failures.push(`${item.name}: ${String(e)}`);
      }
    }
    const st = useApp.getState();
    st.invalidateRemoteCache();
    await st.loadRemote();
    clearSelection();
    if (failures.length > 0) {
      toast.error(
        tr("sftp.batchDeletePartial", { ok: selectedItems.length - failures.length, fail: failures.length, files: failures.join("\n") }),
        tr("sftp.batchDeleteDone")
      );
    } else {
      toast.success(tr("sftp.deletedN", { n: selectedItems.length }));
    }
  };

  const openItemMenu = (item: SftpItem, position: { x: number; y: number }) => {
    menuReturnRef.current = document.activeElement as HTMLElement | null;
    useApp.getState().selectRemote(item);
    if (!selectedPaths.includes(item.path)) {
      setSelectedPaths([item.path]);
      setAnchorPath(item.path);
    }
    setCtx({ ...position, item });
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

  const uploadLocalPath = async (path: string, isDir: boolean) => {
    if (!sftpContext) return;
    const name = path.split(/[\\/]/).pop();
    if (!name) return;
    try {
      if (isDir) {
        await ipc.sftpUploadDir(
          sftpContext.connectionId,
          sftpContext.sessionId,
          path,
          joinPath(remotePath, name)
        );
      } else {
        await ipc.sftpUpload(
          sftpContext.connectionId,
          sftpContext.sessionId,
          path,
          joinPath(remotePath, name)
        );
      }
      toast.success(tr("sftp.queuedUpload", { n: name }));
    } catch (e) {
      toast.error(tr("sftp.uploadFailed", { e: String(e) }));
    }
  };

  const handleMkdir = async () => {
    const st = useApp.getState();
    if (!st.sftpContext) return;
    const name = await promptDialog({
      title: tr("sftp.mkdirTitle"),
      placeholder: tr("sftp.mkdirPh"),
      confirmText: tr("sftp.create"),
    });
    if (!name?.trim()) return;
    try {
      await ipc.sftpMkdir(
        st.sftpContext.connectionId,
        joinPath(st.remotePath, name.trim())
      );
      st.invalidateRemoteCache();
      void st.loadRemote();
      toast.success(tr("sftp.dirCreated"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  // 新建（文件夹/文件）：创建默认名后立即进入重命名状态引导命名（取消则保留默认名）
  const handleCreate = async (kind: "dir" | "file") => {
    const st = useApp.getState();
    if (!st.sftpContext) return;
    setNewMenu(false);
    const defaultName = kind === "dir" ? tr("sftp.newFolderDefault") : tr("sftp.newFileDefault");
    const target = joinPath(st.remotePath, defaultName);
    try {
      if (kind === "dir") {
        await ipc.sftpMkdir(st.sftpContext.connectionId, target);
      } else {
        await ipc.sftpCreateFile(st.sftpContext.connectionId, target);
      }
      st.invalidateRemoteCache();
      await st.loadRemote();
      const name = await promptDialog({
        title: kind === "dir" ? tr("sftp.folderName") : tr("sftp.fileName"),
        defaultValue: defaultName,
        confirmText: tr("sftp.renameTitle"),
      });
      if (name && name.trim() && name.trim() !== defaultName) {
        const newPath = joinPath(st.remotePath, name.trim());
        try {
          await ipc.sftpRename(st.sftpContext.connectionId, target, newPath);
          st.invalidateRemoteCache();
          void st.loadRemote();
          toast.success(kind === "dir" ? tr("sftp.dirCreated") : tr("sftp.fileCreated"));
        } catch (e) {
          toast.error(tr("sftp.renameFailed", { e: String(e) }));
        }
      }
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleDelete = async (item: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) return;
    // 防呆：删除不可恢复；目录删除会递归删除全部内容，需明确警示
    const msg = item.isDir
      ? tr("sftp.deleteDirMsg", { n: item.name })
      : tr("sftp.deleteFileMsg", { n: item.name });
    const confirmed = await confirmDialog({
      title: item.isDir ? tr("sftp.deleteDirTitle") : tr("sftp.deleteFileTitle"),
      message: msg,
      confirmText: tr("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await ipc.sftpRemove(st.sftpContext.connectionId, item.path, item.isDir);
      st.invalidateRemoteCache();
      void st.loadRemote();
      toast.success(tr("sftp.deleted"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleRename = async (item: SftpItem) => {
    const st = useApp.getState();
    if (!st.sftpContext) return;
    const name = await promptDialog({
      title: tr("sftp.renameTitle"),
      defaultValue: item.name,
      confirmText: tr("sftp.renameTitle"),
    });
    if (!name || name === item.name) return;
    const newPath = joinPath(item.path.replace(/\/[^/]+$/, ""), name);
    try {
      await ipc.sftpRename(st.sftpContext.connectionId, item.path, newPath);
      st.invalidateRemoteCache();
      void st.loadRemote();
      toast.success(tr("sftp.renamed"));
    } catch (e) {
      toast.error(String(e));
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
          <Icon name="folder" size={28} />
        </span>
        <div className="workspace__empty-text">
          {pending ? tr("sftp.loading") : tr("sftp.noSessionTitle")}
        </div>
        <div className="workspace__empty-sub">
          {pending ? tr("sftp.bindingTitle") : tr("sftp.noSessionSub")}
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
  const initialLoading = remoteLoading && filteredItems.length === 0;
  const virtualize = filteredItems.length > SFTP_VIRTUALIZE_THRESHOLD;
  const virtualRange = getVirtualRange(
    filteredItems.length,
    listViewport.scrollTop,
    listViewport.height,
    SFTP_ROW_HEIGHT,
    SFTP_OVERSCAN,
    SFTP_HEADER_OFFSET
  );
  const renderedItems = virtualize
    ? filteredItems.slice(virtualRange.start, virtualRange.end)
    : filteredItems;

  return (
    <div className="sftp-view">
      <div className="sftp-toolbar">
        <div className="sftp-pathbar">
          <button
            className="ds-btn ds-btn--tertiary ds-btn--sm"
            type="button"
            title={tr("sftp.upDir")}
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
            className={
              "ds-btn ds-btn--secondary ds-btn--sm" +
              (localOpen ? " is-active" : "")
            }
            type="button"
            title={tr("sftp.localFiles")}
            onClick={() => setLocalOpen((open) => !open)}
          >
            <Icon name="columns" size={12} />
          </button>
          <button
            className={
              "ds-btn ds-btn--secondary ds-btn--sm" +
              (filterOpen ? " is-active" : "")
            }
            type="button"
            title={tr("sftp.filter")}
            onClick={() => {
              const next = !filterOpen;
              setFilterOpen(next);
              if (next) {
                window.setTimeout(() => filterRef.current?.focus(), 30);
              } else {
                setFilterQuery("");
              }
            }}
          >
            <Icon name="search" size={12} />
          </button>
          <button
            className="ds-btn ds-btn--secondary ds-btn--sm"
            type="button"
            title={tr("sftp.quickCmd")}
            onClick={() => void toggleQuickCmd()}
          >
            <Icon name="terminal" size={12} />
          </button>
          <button
            className="ds-btn ds-btn--secondary ds-btn--sm"
            type="button"
            title={tr("sftp.clearScreen")}
            onClick={handleClearTerminal}
          >
            <Icon name="trash" size={12} />
          </button>
          <button
            className="ds-btn ds-btn--secondary ds-btn--sm"
            type="button"
            title={tr("sftp.refresh")}
            onClick={handleRefresh}
          >
            <Icon name="refresh" size={12} />
          </button>
          <span className="sftp-new-wrap">
            <button
              className="ds-btn ds-btn--secondary ds-btn--sm"
              type="button"
              title={tr("sftp.new")}
              onClick={() => setNewMenu((v) => !v)}
            >
              <Icon name="plus" size={12} />
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
                    title={tr("sftp.newDirTitle")}
                    onClick={() => void handleCreate("dir")}
                  >
                    <Icon name="folder" size={12} />新建文件夹
                  </button>
                  <button
                    type="button"
                    className="ctx-menu__item"
                    title={tr("sftp.newFileTitle")}
                    onClick={() => void handleCreate("file")}
                  >
                    <Icon name="file" size={12} />新建文件
                  </button>
                </div>
              </>
            )}
          </span>
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title={
              sftpCollapsed
                ? tr("sftp.expand")
                : tr("sftp.collapse")
            }
            onClick={toggleSftpCollapsed}
          >
            <Icon name={sftpCollapsed ? "chevron-up" : "chevron-down"} size={14} />
          </button>
        </div>
      </div>

      {filterOpen && (
        <div className="sftp-filterbar">
          <Icon name="search" size={12} />
          <input
            ref={filterRef}
            value={filterQuery}
            placeholder={tr("sftp.filterPh")}
            spellCheck={false}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              if (filterQuery) setFilterQuery("");
              else setFilterOpen(false);
            }}
          />
          <span className="sftp-filterbar__count">
            {filterQuery ? tr("sftp.items", { n: filteredItems.length }) : ""}
          </span>
        </div>
      )}

      {/* 已选提示不再占用顶部行高：批量操作走右键菜单，
          数量只显示在底部提示区，避免单击选中后列表下移导致双击点错目录 */}

      {searchOpen && (
        <div className="toolbar__search sftp-search">
          <input
            ref={searchRef}
            className="ds-input toolbar__search-input"
            value={query}
            placeholder={tr("sftp.searchPh")}
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
            title={tr("sftp.prev")}
            onClick={() => doFind("prev")}
          >
            <Icon name="chevron-up" size={13} />
          </button>
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title={tr("sftp.next")}
            onClick={() => doFind("next")}
          >
            <Icon name="chevron-down" size={13} />
          </button>
          <button
            className="ds-btn ds-btn--tertiary ds-btn--icon"
            type="button"
            title={tr("common.close")}
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
        <div className={"sftp-panes" + (localOpen ? " has-local" : "")}>
          {localOpen && <LocalFilesPane />}
          <div
            ref={listRef}
            className={
              "sftp-list sftp-list--remote" +
              (dropHover ? " is-drop-target" : "") +
              (remoteLoading ? " is-loading" : "")
            }
            style={colVars}
            aria-busy={remoteLoading}
            onKeyDown={handleListKeyDown}
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
              const localPath = e.dataTransfer.getData("application/x-termix-local");
              if (localPath) {
                const isDir =
                  e.dataTransfer.getData("application/x-termix-local-dir") === "1";
                void uploadLocalPath(localPath, isDir);
              }
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
              title={tr("sftp.sortName")}
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
              title={tr("sftp.sortSize")}
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
              title={tr("sftp.sortTime")}
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
              title={tr("sftp.sortPerms")}
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
              title={tr("sftp.sortOwner")}
              onClick={() => toggleSort("uid")}
            >
              用户/组<SortArrows state={sortState("uid")} />
              <span
                className="sftp-resizer"
                onPointerDown={(e) => startResize(e, "owner")}
              />
            </button>
          </div>
          {remoteLoading && (
            <div className="sftp-loading" role="status" aria-label={tr("sftp.loadingDir")} />
          )}
          {virtualize && virtualRange.topPadding > 0 && (
            <div
              className="sftp-virtual-spacer"
              style={{ height: virtualRange.topPadding }}
              aria-hidden="true"
            />
          )}
          {renderedItems.map((it) => (
              <div
                key={it.path}
                className={
                  "sftp-row" + (selectedPaths.includes(it.path) ? " is-active" : "")
                }
                onClick={(e) => handleRowClick(it, e)}
                role="button"
                tabIndex={0}
                aria-current={selectedPaths.includes(it.path) ? "true" : undefined}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-termix-remote", it.path);
                  e.dataTransfer.effectAllowed = "copy";
                  if (it.isDir) {
                    e.dataTransfer.setData("application/x-termix-remote-dir", "1");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setSelectedPaths([it.path]);
                    setAnchorPath(it.path);
                    useApp.getState().selectRemote(it);
                    handleOpen(it);
                  } else if (e.key === " ") {
                    e.preventDefault();
                    setSelectedPaths((paths) => toggleSelection(paths, it.path));
                    setAnchorPath(it.path);
                    useApp.getState().selectRemote(it);
                  } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    openItemMenu(it, { x: rect.right, y: rect.bottom });
                  }
                }}
                onDoubleClick={() => handleOpen(it)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openItemMenu(it, { x: e.clientX, y: e.clientY });
                }}
                title={it.path}
              >
                <span className="sftp-row__name">
                  <span
                    className={
                      "sftp-row__icon " + (it.isDir ? "is-dir" : "is-file")
                    }
                  >
                    <Icon name={it.isDir ? "folder" : "file"} size={13} />
                  </span>
                  <span className="sftp-row__label">{it.name}</span>
                </span>
                <span className="sftp-row__cell sftp-row__cell--num">
                  {it.isDir && it.size < 5120 ? "—" : formatSize(it.size)}
                </span>
                <span className="sftp-row__cell">
                  {it.isDir ? tr("sftp.typeDir") : tr("sftp.typeFile")}
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
          {virtualize && virtualRange.bottomPadding > 0 && (
            <div
              className="sftp-virtual-spacer"
              style={{ height: virtualRange.bottomPadding }}
              aria-hidden="true"
            />
          )}
          {initialLoading && <div className="sftp-empty">加载中…</div>}
          {!remoteLoading && remoteError && (
            <div className="sftp-error">
              <span className="sftp-error__icon">
                <Icon name="alert-circle" size={15} />
              </span>
              <div className="sftp-error__body">
                <div className="sftp-error__title">{tr("sftp.loadFailed")}</div>
                <div className="sftp-error__msg" title={remoteError}>
                  {remoteError}
                </div>
              </div>
              <button
                className="ds-btn ds-btn--secondary ds-btn--sm"
                type="button"
                title={tr("sftp.refresh")}
                onClick={handleRefresh}
              >
                重试
              </button>
            </div>
          )}
          {!remoteLoading && !remoteError && filteredItems.length === 0 && (
            <div className="sftp-empty">
              <div>{filterQuery ? tr("sftp.noMatch") : tr("sftp.emptyDir")}</div>
              <div className="sftp-empty__fun">
                {pickFunLocalized(
                  "sftpEmpty",
                  filteredItems.length + remotePath.length,
                  getLang()
                )}
              </div>
            </div>
          )}
            <div className="sftp-pane__hint">
              <span>{selectionHint(selectedPaths.length, tr)}</span>
              {selectedPaths.length > 0 && (
                <button
                  className="sftp-hint__clear"
                  type="button"
                  title={tr("sftp.clearSel")}
                  onClick={clearSelection}
                >
                  清空
                </button>
              )}
            </div>
          </div>
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
                  <span className="toolbar__qc-title">{tr("sftp.fillVars", { t: cmdEditing.title })}</span>
                  <button
                    className="ds-btn ds-btn--tertiary ds-btn--icon"
                    type="button"
                    title={tr("common.close")}
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
                      placeholder={v.defaultValue ? tr("sftp.varDefault", { d: v.defaultValue }) : tr("sftp.varDefaultEmpty")}
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
                    title={tr("sftp.backToList")}
                    onClick={() => setCmdEditing(null)}
                  >
                    返回
                  </button>
                  <button
                    className="ds-btn ds-btn--brand"
                    type="button"
                    title={tr("sftp.execVars")}
                    onClick={() => void confirmQuickCmd()}
                  >
                    执行
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="toolbar__qc-head">
                  <span className="toolbar__qc-title">{tr("sftp.quickCmdTitle")}</span>
                  <button
                    className="ds-btn ds-btn--tertiary ds-btn--icon"
                    type="button"
                    title={tr("sftp.closeQuickCmd")}
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
                  placeholder={tr("sftp.searchCmdPh")}
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
                      {tr("sftp.noSnippet")}
                    </div>
                  )}
                  {filteredSnippets.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="toolbar__qc-item"
                      title={tr("sftp.sendCmd", { t: s.title })}
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
          style={{ left: ctxPosition?.x ?? ctx.x, top: ctxPosition?.y ?? ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctx.item && selectedPaths.length > 1 && selectedPaths.includes(ctx.item.path) ? (
            <>
              <button
                type="button"
                className="ctx-menu__item"
                title={tr("sftp.downloadN", { n: selectedPaths.length })}
                onClick={() => {
                  setCtx(null);
                  void downloadSelected();
                }}
              >
                <Icon name="download" size={12} />
                下载 {selectedPaths.length} 项
              </button>
              <button
                type="button"
                className="ctx-menu__item"
                title={tr("sftp.copyNPaths", { n: selectedPaths.length })}
                onClick={() => {
                  setCtx(null);
                  void copySelectedPaths();
                }}
              >
                <Icon name="copy" size={12} />
                复制 {selectedPaths.length} 个路径
              </button>
              <div className="ctx-menu__sep" />
              <button
                type="button"
                className="ctx-menu__item ctx-menu__item--danger"
                title={tr("sftp.deleteN", { n: selectedPaths.length })}
                onClick={() => {
                  setCtx(null);
                  void deleteSelected();
                }}
              >
                <Icon name="trash" size={12} />
                删除 {selectedPaths.length} 项
              </button>
            </>
          ) : (
            sftpContextMenu("remote", ctx.item).map((m) => (
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
            ))
          )}
        </div>
      )}
    </div>
  );
}
