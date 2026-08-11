export type AuthType = "password" | "key";

export interface Session {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  groupId?: string;
  memo?: string;
  encoding: string;
  createdAt: number;
  lastConnectedAt?: number;
}

export interface SessionInput {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  groupId?: string;
  memo?: string;
  encoding?: string;
}

export interface Group {
  id: string;
  name: string;
  parentId?: string;
  order: number;
}

export interface GroupInput {
  name: string;
  parentId?: string;
}

export interface CommandHistory {
  id: string;
  sessionId: string;
  command: string;
  executedAt: number;
}

export type TabKind = "terminal";

export interface Tab {
  id: string;
  kind: TabKind;
  sessionId: string;
  connectionId?: string;
  shellId?: string;
  title: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  error?: string;
}

// ---- v0.2: SFTP ----

export interface SftpItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
  perms?: number;
}

export interface TransferTask {
  id: string;
  sessionId: string;
  fileName: string;
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
  status: "running" | "completed" | "failed" | "cancelled";
  progress: number;
  speed: number;
  error?: string;
}

export interface TransferProgressEvent {
  taskId: string;
  fileName?: string;
  direction?: string;
  progress?: number;
  speed?: number;
  status?: string;
  error?: string;
}

/** 主功能区（Activity Rail） */
export type Activity =
  | "terminal"
  | "sftp"
  | "forward"
  | "snippets"
  | "monitor"
  | "plugins"
  | "help"
  | "settings";

// ---- v0.3: 端口转发 ----

export interface ForwardRule {
  id: string;
  type: "local" | "remote" | "dynamic";
  name: string;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  sessionId?: string;
  enabled: boolean;
}

export interface ForwardRuleInput {
  type: "local" | "remote" | "dynamic";
  name: string;
  localHost?: string;
  localPort: number;
  remoteHost?: string;
  remotePort: number;
  sessionId?: string;
}

// ---- v0.3: 命令片段 ----

export interface Snippet {
  id: string;
  title: string;
  command: string;
  variables: string;
  groupId?: string;
  createdAt: number;
}

export interface SnippetInput {
  title: string;
  command: string;
  variables?: string;
  groupId?: string;
}

// ---- v0.3: 系统监控 ----

export interface Metrics {
  cpu: number;
  memUsed: number;
  memTotal: number;
  diskUsedPct: number;
  netRx: number;
  netTx: number;
}

export interface ProcInfo {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  cmd: string;
}
