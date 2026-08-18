import { useEffect } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";

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
      "新建连接：点击标题栏「新建连接」或按 ⌘/Ctrl+T，填写名称、主机与认证信息后保存",
      "打开终端：双击左侧会话列表的会话，或右键选择「在新标签连接」",
      "多标签：标签栏右键可关闭 / 关闭其他 / 关闭右侧 / 复制 / 重命名标签",
      "备份迁移：通过会话导出 / 导入，把会话与分组保存为 JSON 并在其他设备恢复",
    ],
  },
  {
    icon: "terminal",
    title: "终端使用",
    desc: "终端窗口与底部文件面板一体化，切换到其他模块时终端仅隐藏而不卸载，会话输出与连接状态不会丢失。",
    items: [
      "执行命令：在底部输入框输入并回车执行，↑↓ 键切换历史（历史按会话持久化）",
      "复制粘贴：选中文本后右键「复制」写入系统剪贴板；多行粘贴会先确认再发送",
      "终端内搜索：按 Ctrl+F 高亮搜索当前终端输出",
      "保存日志：通过终端视图工具栏将当前会话输出保存为 .log 文件",
      "自动重连：网络意外断开时自动重连（最多 3 次），手动断开不触发重连",
      "空闲保活：SSH 每 30 秒发送心跳，连续 3 次无响应判定断线",
    ],
  },
  {
    icon: "key",
    title: "快捷键",
    kbd: [
      { label: "新建连接", keys: "⌘ / Ctrl + T" },
      { label: "断开当前连接", keys: "⌘ / Ctrl + D" },
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
      "上传：把系统文件拖入文件面板即上传到当前目录（支持批量）",
      "下载：文件右键「下载」、目录右键「下载目录」；本地已有同名文件 / 目录时先确认",
      "文件操作：右键重命名 / 删除 / 复制路径；空白处右键新建文件夹 / 刷新",
      "列表信息：名称 / 大小 / 类型 / 修改时间 / 权限 / 属主六列，点击列头排序",
      "断点续传：传输中断后自动从断点继续，已完整的文件自动跳过",
      "传输队列：右侧面板展示实时进度与速率，支持暂停 / 恢复 / 取消与失败重试",
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
    desc: "右侧常驻面板与「监控」模块由同一轮询驱动，两处数据保持一致。",
    items: [
      "常驻指标：CPU / 内存 / 磁盘 / 网络速率 / 网络连接数，颜色分级提示",
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
        a: "不会。上传 / 下载支持断点续传，中断后重试会从断点继续，已完整的文件自动跳过。",
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
        a: "若之前导出过备份 JSON，可通过会话导入恢复；未备份的数据无法找回。",
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

export function HelpView() {
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
        <span className="fw-toolbar__title">帮助与文档</span>
      </div>
      <div className="st-body">
        {BLOCKS.map((b) => (
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
