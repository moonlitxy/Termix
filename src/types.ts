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

export interface SessionImportResult {
  groupsCreated: number;
  sessionsCreated: number;
  sessionsSkipped: number;
  /** 因密文无法用当前主密钥解密而被清空的密码字段数量 */
  secretsCleared: number;
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
  /** 分屏 pane 标签：不在标签栏显示 */
  hidden?: boolean;
  /** 分屏 pane 标签：所属主标签 id */
  splitOf?: string;
  /** 用户手动断开标记：置位后意外断开不再自动重连 */
  manualClosed?: boolean;
}

// ---- v0.2: SFTP ----

export interface SftpItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
  perms?: number;
  /** 数值 uid（服务端未返回时缺省） */
  uid?: number;
  /** 数值 gid（服务端未返回时缺省） */
  gid?: number;
  /** 用户名（服务端 /etc/passwd 映射，缺省时用数值 uid） */
  userName?: string;
  /** 组名（服务端 /etc/group 映射） */
  groupName?: string;
}

export interface TransferTask {
  id: string;
  sessionId: string;
  fileName: string;
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  progress: number;
  speed: number;
  error?: string;
  isDir?: boolean;
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

export interface DiskInfo {
  mount: string;
  total: number;
  used: number;
  pct: number;
}

export interface Metrics {
  cpu: number;
  memUsed: number;
  memTotal: number;
  diskUsedPct: number;
  netRx: number;
  netTx: number;
  netConns: number;
  disks: DiskInfo[];
  /** 系统已运行时间（秒） */
  uptime: number;
  /** 系统负载（1/5/15 分钟） */
  load1: number;
  load5: number;
  load15: number;
}

export interface ProcInfo {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  cmd: string;
}

/** 服务器系统信息（系统信息模块） */
export interface SysInfo {
  osName: string;
  osVersion: string;
  kernel: string;
  arch: string;
  cpuCores: number;
  cpuModel: string;
  memTotal: number;
  memUsed: number;
  disks: DiskInfo[];
}

// ---- 安全（主密码） ----

export interface MasterStatus {
  hasMaster: boolean;
  unlocked: boolean;
}

// ---- 软件更新 ----

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  assetUrl: string;
  assetName: string;
  releaseNotes: string;
}

export interface UpdateProgressEvent {
  fileName: string;
  received: number;
  total: number;
  percent: number;
}
