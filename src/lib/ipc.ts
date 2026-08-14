import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CommandHistory,
  ForwardRule,
  ForwardRuleInput,
  Group,
  GroupInput,
  MasterStatus,
  Metrics,
  ProcInfo,
  Session,
  SessionImportResult,
  SessionInput,
  SftpItem,
  Snippet,
  SnippetInput,
  TransferProgressEvent,
  TransferTask,
} from "../types";

export const ipc = {
  // sessions
  sessionList: () => invoke<Session[]>("session_list"),
  sessionCreate: (input: SessionInput) => invoke<string>("session_create", { input }),
  sessionUpdate: (id: string, input: SessionInput) =>
    invoke<void>("session_update", { id, input }),
  sessionDelete: (id: string) => invoke<void>("session_delete", { id }),
  sessionsExport: () => invoke<string>("sessions_export"),
  sessionsImport: (content: string) =>
    invoke<SessionImportResult>("sessions_import", { content }),

  // groups
  groupList: () => invoke<Group[]>("group_list"),
  groupCreate: (input: GroupInput) => invoke<string>("group_create", { input }),
  groupDelete: (id: string) => invoke<void>("group_delete", { id }),

  // connection
  sessionConnect: (id: string) => invoke<string>("session_connect", { id }),
  sessionDisconnect: (connectionId: string) =>
    invoke<void>("session_disconnect", { connectionId }),
  // 主机密钥（TOFU）：信任并保存指纹
  hostKeyAccept: (host: string, port: number, fingerprint: string) =>
    invoke<void>("host_key_accept", { host, port, fingerprint }),

  // terminal
  terminalCreate: (connectionId: string, tabId: string, cols: number, rows: number) =>
    invoke<string>("terminal_create", { connectionId, tabId, cols, rows }),
  terminalWrite: (connectionId: string, shellId: string, data: string) =>
    invoke<void>("terminal_write", { connectionId, shellId, data }),
  terminalResize: (connectionId: string, shellId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { connectionId, shellId, cols, rows }),
  terminalDestroy: (connectionId: string, shellId: string) =>
    invoke<void>("terminal_destroy", { connectionId, shellId }),

  // history
  historyList: (sessionId: string, limit = 50) =>
    invoke<CommandHistory[]>("history_list", { sessionId, limit }),
  historyAdd: (sessionId: string, command: string) =>
    invoke<string>("history_add", { sessionId, command }),
  historyClear: (sessionId: string) => invoke<void>("history_clear", { sessionId }),

  // ---- v0.2: SFTP ----
  sftpList: (connectionId: string, path: string) =>
    invoke<SftpItem[]>("sftp_list", { connectionId, path }),
  sftpMkdir: (connectionId: string, path: string) =>
    invoke<void>("sftp_mkdir", { connectionId, path }),
  sftpRemove: (connectionId: string, path: string, isDir: boolean) =>
    invoke<void>("sftp_remove", { connectionId, path, isDir }),
  sftpRename: (connectionId: string, oldPath: string, newPath: string) =>
    invoke<void>("sftp_rename", { connectionId, oldPath, newPath }),
  sftpChmod: (connectionId: string, path: string, mode: number) =>
    invoke<void>("sftp_chmod", { connectionId, path, mode }),
  sftpUpload: (
    connectionId: string,
    sessionId: string,
    localPath: string,
    remotePath: string
  ) => invoke<string>("sftp_upload", { connectionId, sessionId, localPath, remotePath }),
  sftpDownload: (
    connectionId: string,
    sessionId: string,
    remotePath: string,
    localPath: string
  ) => invoke<string>("sftp_download", { connectionId, sessionId, remotePath, localPath }),
  sftpUploadDir: (
    connectionId: string,
    sessionId: string,
    localPath: string,
    remotePath: string
  ) => invoke<string>("sftp_upload_dir", { connectionId, sessionId, localPath, remotePath }),
  sftpDownloadDir: (
    connectionId: string,
    sessionId: string,
    remotePath: string,
    localPath: string
  ) => invoke<string>("sftp_download_dir", { connectionId, sessionId, remotePath, localPath }),

  // transfers
  transferList: () => invoke<TransferTask[]>("transfer_list"),
  transferCancel: (taskId: string) => invoke<void>("transfer_cancel", { taskId }),
  transferPause: (taskId: string) => invoke<void>("transfer_pause", { taskId }),
  transferResume: (taskId: string) => invoke<void>("transfer_resume", { taskId }),

  // local fs
  localList: (path: string) => invoke<SftpItem[]>("local_list", { path }),
  localHome: () => invoke<string>("local_home"),

  // ---- v0.3: 命令片段 ----
  snippetList: () => invoke<Snippet[]>("snippet_list"),
  snippetCreate: (input: SnippetInput) => invoke<string>("snippet_create", { input }),
  snippetUpdate: (id: string, input: SnippetInput) =>
    invoke<void>("snippet_update", { id, input }),
  snippetDelete: (id: string) => invoke<void>("snippet_delete", { id }),

  // ---- v0.3: 端口转发 ----
  forwardList: () => invoke<ForwardRule[]>("forward_list"),
  forwardCreate: (input: ForwardRuleInput) =>
    invoke<string>("forward_create", { input }),
  forwardUpdate: (id: string, input: ForwardRuleInput) =>
    invoke<void>("forward_update", { id, input }),
  forwardDelete: (id: string) => invoke<void>("forward_delete", { id }),
  forwardStart: (id: string) => invoke<void>("forward_start", { id }),
  forwardStop: (id: string) => invoke<void>("forward_stop", { id }),

  // ---- v0.3: 系统监控 ----
  monitorMetrics: (connectionId: string) =>
    invoke<Metrics>("monitor_metrics", { connectionId }),
  monitorProcesses: (connectionId: string, limit = 20) =>
    invoke<ProcInfo[]>("monitor_processes", { connectionId, limit }),

  // ---- 安全（主密码） ----
  masterStatus: () => invoke<MasterStatus>("master_status"),
  masterSet: (master: string, oldMaster?: string) =>
    invoke<void>("master_set", { master, oldMaster }),
  masterUnlock: (master: string) => invoke<void>("master_unlock", { master }),
  masterLock: () => invoke<void>("master_lock"),
  masterClear: (master: string) => invoke<void>("master_clear", { master }),
};

export interface TerminalOutputEvent {
  shellId: string;
  data: string;
  tabId: string;
}

export interface ConnectionStatusEvent {
  shellId: string;
  tabId: string;
  status: string;
}

export function onTerminalOutput(cb: (e: TerminalOutputEvent) => void): Promise<UnlistenFn> {
  return listen<TerminalOutputEvent>("terminal-output", (ev) => cb(ev.payload));
}

export function onConnectionStatus(
  cb: (e: ConnectionStatusEvent) => void
): Promise<UnlistenFn> {
  return listen<ConnectionStatusEvent>("connection-status", (ev) => cb(ev.payload));
}

export function onTransferProgress(
  cb: (e: TransferProgressEvent) => void
): Promise<UnlistenFn> {
  return listen<TransferProgressEvent>("transfer-progress", (ev) => cb(ev.payload));
}
