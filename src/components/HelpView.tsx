import { useEffect } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { getLang, useT } from "../lib/i18n";

interface Faq {
  q: string;
  a: string;
}

interface HelpBlock {
  /** 锚点 id（`help-${id}`），供「关于 Termix」跳转定位 */
  id?: string;
  icon: string;
  title: string;
  desc?: string;
  items?: string[];
  kbd?: { label: string; keys: string }[];
  faq?: Faq[];
  note?: string;
}

const BLOCKS: HelpBlock[] = [
  {
    id: "start",
    icon: "zap",
    title: "快速上手",
    desc: "Termix 将 SSH 连接、文件管理、端口转发与系统监控整合在一个窗口内，所有数据保存在本机。",
    items: [
      "新建连接：点击会话栏右上角 +，或按 ⌘/Ctrl+T，填写名称、主机与认证信息后保存",
      "打开终端：双击左侧会话列表的会话，或右键选择「在新标签连接」",
      "多标签：标签栏右键可关闭 / 关闭其他 / 关闭右侧 / 复制 / 分屏 / 重命名标签",
      "备份迁移：通过会话导出 / 导入，把会话与分组保存为 JSON 并在其他设备恢复",
      "认证方式：密码、私钥、键盘交互（2FA，按提示输验证码）、SSH Agent（本机密钥）四选一",
      "跳板机：新建连接时可选另一已保存会话作跳板（仅一级），会话行会显示「经跳板」",
    ],
  },
  {
    icon: "terminal",
    title: "终端使用",
    desc: "终端窗口与底部文件面板一体化，切换到其他模块时终端仅隐藏而不卸载，会话输出与连接状态不会丢失。",
    items: [
      "执行命令：按 Ctrl+L 唤出底部输入框，↑↓ 键切换历史（历史按会话持久化）",
      "同步输入：状态栏「同步输入」开启后，本终端输入会同步写到其他已连接标签（含分屏）",
      "复制粘贴：选中文本后右键「复制」或按 Cmd/Ctrl+C；多行粘贴会先确认再发送",
      "终端内搜索：按 Ctrl+F 高亮搜索当前终端输出",
      "保存日志：终端右键菜单「保存日志」将当前缓冲区导出为 .log 文件",
      "自动重连：网络意外断开时自动重连（最多 3 次），手动断开不触发重连",
      "空闲保活：SSH 每 30 秒发送心跳，连续 3 次无响应判定断线",
    ],
  },
  {
    icon: "key",
    title: "快捷键",
    kbd: [
      { label: "全局搜索", keys: "⌘ / Ctrl + K" },
      { label: "新建连接", keys: "⌘ / Ctrl + T" },
      { label: "断开当前连接", keys: "⌘ / Ctrl + D" },
      { label: "底部命令输入", keys: "Ctrl + L" },
      { label: "终端字号缩放", keys: "Ctrl + / -" },
      { label: "终端内搜索", keys: "Ctrl + F" },
      { label: "命令历史", keys: "↑ / ↓" },
    ],
  },
  {
    icon: "folder",
    title: "SFTP 文件面板",
    desc: "会话连接后，窗口底部展示远程文件系统，可拖拽分隔条调整高度，也可点击工具栏收起。",
    items: [
      "上传：把系统文件 / 目录拖入文件面板即上传到当前目录（支持批量）",
      "下载：文件右键「下载」、目录右键「下载目录」；本地已有同名文件 / 目录时先确认",
      "本地文件：点击文件面板工具栏的分栏按钮打开本地目录；支持右键新建/重命名/删除，可在本地与远程列表之间双向拖拽",
      "文件操作：右键重命名 / 删除 / 复制路径；空白处右键新建文件夹 / 刷新",
      "列表信息：名称 / 大小 / 类型 / 修改时间 / 权限 / 属主六列，点击列头排序",
      "断点续传：单文件中途失败可从断点继续；目录传输目前仅支持取消",
      "传输队列：右侧面板展示实时进度与速率，单文件支持暂停 / 恢复，所有任务支持取消与失败重试",
    ],
  },
  {
    icon: "plug",
    title: "端口转发",
    desc: "支持三类端口转发，规则可随时启停、编辑，端口被占用时会提前检测提示。",
    items: [
      "本地转发：将本机端口流量经 SSH 隧道转发到远程目标",
      "远程转发：在远程服务器上监听端口，把连接经隧道转回本地目标",
      "动态转发：本机 SOCKS5 代理，支持 IPv4 / 域名 / IPv6 目标",
    ],
  },
  {
    icon: "scroll-text",
    title: "命令片段与快捷命令",
    items: [
      "命令片段：集中管理常用命令，支持 {{var}} 变量占位符，可一键插入终端",
      "快捷命令：文件面板工具栏「快捷命令」弹出搜索面板，按关键字过滤后一键发送",
      "变量填充：包含占位符的片段在发送前弹出表单，填写后自动替换",
      "历史互通：终端直接输入 / 底部输入框 / 快捷命令写入同一份命令历史",
    ],
  },
  {
    icon: "bar",
    title: "系统监控",
    desc: "右侧面板展开后与「监控」模块共用同一轮询，两处数据保持一致。",
    items: [
      "展开指标：CPU / 内存 / 磁盘 / 网络速率 / 网络连接数，颜色分级提示",
      "监控详情：指标卡 + CPU 实时曲线 + 磁盘分区详情 + 进程 Top",
      "系统信息：CPU 核心数 / 主频 / 运行时长",
      "刷新间隔：在「设置 → 监控」中调整（1 / 2 / 5 秒）",
    ],
  },
  {
    icon: "eye",
    title: "主密码安全",
    desc: "主密码使用 PBKDF2 派生密钥，会话密码与私钥密码以 AES-256-GCM 加密后落库。",
    items: [
      "设置与修改：在「设置 → 安全」设置或修改主密码，此后密码自动加密存储",
      "解锁与锁定：重新打开应用后处于锁定状态，解锁后才能解密并连接；也可手动锁定",
      "导出：解锁状态下导出会话，密码以明文写入备份 JSON，便于跨设备迁移",
      "清除：清除主密码后，会话密码恢复明文存储",
    ],
    note: "主密码密钥仅保存在内存，不写入磁盘；忘记主密码无法找回，只能清除后重新设置。",
  },
  {
    id: "faq",
    icon: "help",
    title: "常见问题",
    faq: [
      {
        q: "为什么连接被拒绝并提示主机密钥变更？",
        a: "Termix 采用 TOFU 信任机制：首次连接需确认服务器指纹，后续连接若指纹与已保存记录不一致将拒绝连接，以防范中间人攻击。重装系统或更换服务器后指纹会变化，属正常现象。",
      },
      {
        q: "传输中断后文件会损坏吗？",
        a: "不会。单文件上传 / 下载支持断点续传，中断后重试会从断点继续；目录传输目前仅支持取消后重新发起。",
      },
      {
        q: "能连接 Windows 远程服务器吗？",
        a: "当前终端、SFTP 与系统监控面向 Linux / Unix 服务器，远程 Windows 兼容暂未接入。",
      },
      {
        q: "数据保存在哪里？",
        a: "正式安装版使用系统应用数据目录；开发调试版使用项目内 .termix-data/ 目录（已 gitignore，不会提交）。",
      },
      {
        q: "误删的会话能恢复吗？",
        a: "每次会话/分组变更都会自动备份（数据目录 backups/ 下保留最新 10 份），可在「设置 → 数据备份」里一键恢复；手动导出的 JSON 备份同样可导入恢复。",
      },
      {
        q: "如何从 ~/.ssh/config 迁移主机？",
        a: "点击会话栏导入按钮 →「读取 ~/.ssh/config」一键导入，或选「SSH Config 文件导入」挑文件；IdentityFile 走私钥认证、无密码的走密码认证（密码留空，连接时填写）。",
      },
      {
        q: "服务器开了 2FA / 谷歌验证码怎么连？",
        a: "新建连接时认证方式选「键盘交互（2FA）」，连接过程中按服务器提示输入验证码即可（120 秒内有效）。",
      },
      {
        q: "Agent 转发（ssh -A）支持吗？",
        a: "支持。连接时勾选「转发 SSH Agent 到远端」，远端即可用你本机 Agent 的密钥继续跳转；登录本身也可直接选「SSH Agent」认证。",
      },
    ],
  },
  {
    id: "about",
    icon: "info-circle",
    title: "关于 Termix",
    desc: "Termix 是一款轻量级跨平台 SSH 终端工具（macOS / Windows），对标 MobaXterm / FinalShell。",
    kbd: [
      { label: "当前版本", keys: __TERMIX_VERSION__ },
      { label: "技术栈", keys: "Tauri 2 + Rust + React 18" },
      { label: "数据存储", keys: "SQLite（本机）" },
    ],
    note: "安装包小（5-15MB），内存占用约为 Electron 的三分之一。代码与发布信息见仓库 README。",
  },
];

const BLOCKS_EN: HelpBlock[] = [
  {
    id: "start",
    icon: "zap",
    title: "Getting started",
    desc: "Termix bundles SSH, file management, port forwarding and system monitoring in one window; all data stays on your machine.",
    items: [
      "New connection: click + in the session header or press ⌘/Ctrl+T, then fill in name, host and auth",
      "Open a terminal: double-click a session on the left, or right-click → “Open in new tab”",
      "Tabs: right-click a tab to close / close others / close right / duplicate / split / rename",
      "Backup & migration: export / import sessions and groups as JSON and restore on another device",
      "Auth methods: password, private key, keyboard-interactive (2FA codes) and SSH Agent",
      "Jump host: pick another saved session as a single-level jump host; rows show a “via jump” badge",
    ],
  },
  {
    icon: "terminal",
    title: "Terminal",
    desc: "The terminal and the bottom file panel share one window; switching modules only hides the terminal, so output and connection state survive.",
    items: [
      "Run commands: press Ctrl+L for the bottom input, ↑↓ to browse persisted history",
      "Broadcast input: enable it in the status bar to mirror keystrokes to other connected tabs (split panes included)",
      "Copy/paste: select then right-click “Copy” or Cmd/Ctrl+C; multi-line paste asks for confirmation",
      "Search: Ctrl+F highlights matches in the current terminal buffer",
      "Save log: terminal context menu exports the current buffer to a .log file",
      "Auto-reconnect: recovers from unexpected drops up to 3 times; manual disconnects are not retried",
      "Keepalive: a heartbeat every 30s; 3 missed responses mark the link dead",
    ],
  },
  {
    icon: "key",
    title: "Shortcuts",
    kbd: [
      { label: "Global search", keys: "⌘ / Ctrl + K" },
      { label: "New connection", keys: "⌘ / Ctrl + T" },
      { label: "Disconnect", keys: "⌘ / Ctrl + D" },
      { label: "Bottom command input", keys: "Ctrl + L" },
      { label: "Terminal font zoom", keys: "Ctrl + / -" },
      { label: "Search in terminal", keys: "Ctrl + F" },
      { label: "Command history", keys: "↑ / ↓" },
    ],
  },
  {
    icon: "folder",
    title: "SFTP panel",
    desc: "After connecting, the remote file system appears at the bottom; drag the divider to resize or collapse it from the toolbar.",
    items: [
      "Upload: drag files or folders from your system into the panel (batches supported)",
      "Download: right-click a file → Download, a folder → Download folder; existing local items ask first",
      "Local files: toggle the local pane from the toolbar; right-click to create/rename/delete and drag between panes",
      "Actions: rename / delete / copy path; empty-area menu creates a folder or refreshes",
      "Columns: name / size / type / modified / permissions / owner, click headers to sort",
      "Resume: single-file transfers resume from a breakpoint; folder transfers can only be cancelled",
      "Queue: the right panel shows live progress and speed; single files can pause/resume, all tasks can cancel or retry",
    ],
  },
  {
    icon: "plug",
    title: "Port forwarding",
    desc: "Three forwarding types, each toggleable and editable; busy ports are detected up front.",
    items: [
      "Local: forward a local port through the SSH tunnel to a remote target",
      "Remote: listen on the server and tunnel connections back to a local target",
      "Dynamic: a local SOCKS5 proxy supporting IPv4 / hostnames / IPv6",
    ],
  },
  {
    icon: "scroll-text",
    title: "Snippets & quick commands",
    items: [
      "Snippets: manage frequent commands with {{var}} placeholders and insert them into the terminal",
      "Quick commands: the file panel toolbar opens a search panel; filter and send with one click",
      "Variables: snippets with placeholders prompt for values before sending",
      "Shared history: terminal input, the bottom bar and quick commands write to the same per-session history",
    ],
  },
  {
    icon: "bar",
    title: "Monitoring",
    desc: "The right panel and the Monitor module share one polling loop, so figures always agree.",
    items: [
      "Metrics: CPU / memory / disk / network throughput / connection count with severity colours",
      "Details: metric cards + live CPU chart + disk partitions + top processes",
      "System info: CPU cores / frequency / uptime",
      "Interval: adjust in Settings → Monitor (1 / 2 / 5 s)",
    ],
  },
  {
    icon: "eye",
    title: "Master password",
    desc: "PBKDF2 derives the key; session and key passphrases are stored with AES-256-GCM.",
    items: [
      "Set/change: in Settings → Security; secrets are encrypted from then on",
      "Unlock/lock: the app starts locked; unlock to decrypt and connect, or lock manually",
      "Export: while unlocked, exporting writes plaintext secrets to the JSON for easy migration",
      "Clear: clearing the master password returns secrets to plaintext storage",
    ],
    note: "The key lives in memory only. A forgotten master password cannot be recovered — clear and set a new one.",
  },
  {
    id: "faq",
    icon: "help",
    title: "FAQ",
    faq: [
      {
        q: "Why was the connection rejected with a host-key warning?",
        a: "Termix uses TOFU: the first connection asks you to confirm the fingerprint, and later mismatches are rejected to prevent MITM attacks. A reinstall or server swap changes the fingerprint — that is expected.",
      },
      {
        q: "Can an interrupted transfer corrupt files?",
        a: "No. Single-file transfers resume from the breakpoint; folder transfers can be cancelled and restarted.",
      },
      {
        q: "Can I connect to a remote Windows server?",
        a: "Terminal, SFTP and monitoring currently target Linux/Unix servers; remote Windows support is not wired up yet.",
      },
      {
        q: "Where is data stored?",
        a: "Release builds use the OS app-data directory; dev builds use .termix-data/ in the repo (gitignored).",
      },
      {
        q: "Can I recover a deleted session?",
        a: "Every session/group change writes a snapshot under backups/ (latest 10 kept) — restore from Settings → Backups. Exported JSON backups can also be imported.",
      },
      {
        q: "How do I migrate hosts from ~/.ssh/config?",
        a: "Click the import button → “Read ~/.ssh/config”, or choose “Import SSH config file”. IdentityFile maps to key auth; hosts without one use password auth (left empty until you connect).",
      },
      {
        q: "How do I handle 2FA / authenticator codes?",
        a: "Pick “Keyboard-interactive (2FA)” as the auth method; you will be prompted for each code during connection (valid for 120 seconds).",
      },
      {
        q: "Is SSH Agent forwarding (ssh -A) supported?",
        a: "Yes. Tick “Forward SSH Agent” when creating the connection, and the remote side can reuse your local agent keys. You can also authenticate directly with “SSH Agent”.",
      },
    ],
  },
  {
    id: "about",
    icon: "info-circle",
    title: "About Termix",
    desc: "Termix is a lightweight cross-platform SSH client (macOS / Windows) in the spirit of MobaXterm / FinalShell.",
    kbd: [
      { label: "Version", keys: __TERMIX_VERSION__ },
      { label: "Stack", keys: "Tauri 2 + Rust + React 18" },
      { label: "Storage", keys: "SQLite (local)" },
    ],
    note: "Small installer (5-15MB) and roughly a third of Electron's memory footprint. See the repository README for code and releases.",
  },
];

export function HelpView() {
  const t = useT();
  const helpAnchor = useApp((s) => s.helpAnchor);

  // 标题栏「关于 Termix」跳转帮助页后，定位到「关于」区块（含版本信息）
  useEffect(() => {
    if (!helpAnchor) return;
    useApp.getState().setHelpAnchor(null);
    const el = document.getElementById(`help-${helpAnchor}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [helpAnchor]);

  return (
    <div className="st-view">
      <div className="fw-toolbar">
        <span className="fw-toolbar__title">{t("help.title")}</span>
      </div>
      <div className="st-body">
        {(getLang() === "en" ? BLOCKS_EN : BLOCKS).map((b) => (
          <div
            className="ds-card st-section"
            key={b.title}
            id={b.id ? `help-${b.id}` : undefined}
          >
            <div className="res-card__head">
              <span className="res-card__label">
                <Icon name={b.icon} size={14} />
                {b.title}
              </span>
            </div>
            {b.desc && <p className="hp-desc">{b.desc}</p>}
            {b.kbd && (
              <div className="st-section">
                {b.kbd.map((k) => (
                  <div className="st-row" key={k.label}>
                    <label>{k.label}</label>
                    <span className="st-kbd">{k.keys}</span>
                  </div>
                ))}
              </div>
            )}
            {b.items && (
              <ul className="hp-list">
                {b.items.map((it) => (
                  <li className="hp-list__item" key={it}>
                    {it}
                  </li>
                ))}
              </ul>
            )}
            {b.faq && (
              <div className="hp-faq-group">
                {b.faq.map((f) => (
                  <div className="hp-faq" key={f.q}>
                    <div className="hp-faq__q">{f.q}</div>
                    <div className="hp-faq__a">{f.a}</div>
                  </div>
                ))}
              </div>
            )}
            {b.note && <div className="st-hint">{b.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
