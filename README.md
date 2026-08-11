# Termix

跨平台（macOS / Windows）SSH 终端连接工具，对标 MobaXterm / FinalShell，集成连接管理、多标签终端、SFTP、端口转发、系统监控等能力。基于 Tauri 2 构建，**安装包小（5-15MB）、内存占用低（约为 Electron 1/3）**。

> 产品需求：`design/PRD.md` · 设计原型：`design/pages/index-v2.html`

---

## 功能特性

### 连接管理
- 新建 / 编辑 / 删除 / 分组 SSH 连接，支持密码与私钥认证
- 会话侧边栏：最近连接、分组、在线/离线/连接中状态圆点，双击打开终端
- 会话右键菜单：在新标签连接 / 编辑 / 复制连接信息 / 删除
- **会话导入/导出**：JSON 备份（含分组），同名去重合并，导出时解锁主密码可导出明文密码
- 标题栏全局搜索（按名称 / 主机 / 用户名过滤）

### 终端
- 多标签终端（xterm.js），标签右键：关闭 / 关闭其他 / 关闭右侧 / 复制标签 / 重命名标签
- **分屏**：工具栏一键分屏（同会话最多 4 个独立终端并排，可单独关闭）
- **终端右键菜单**：复制 / 粘贴 / 清屏；多行粘贴先确认再发送
- 命令输入区：执行、历史下拉（按会话持久化、上下键切换）
- 工具栏：复制选中、保存日志、清屏、断开、**快捷命令面板**（搜索片段 + 一键发送 + 变量填充）
- 快捷键：`⌘/Ctrl+T` 新建连接、`⌘/Ctrl+D` 断开、`Ctrl+/-` 字号缩放、`Ctrl+F` 终端内搜索
- 命令片段：CRUD + 一键插入 + `{{var}}` 变量交互填充
- **SSH 心跳保活**（keepalive 30s×3，空闲保活、断线自动重连）；意外断线自动重连（最多 3 次）

### SFTP
- 本地 / 远程双栏文件管理，双击进目录、路径栏跳转
- 上传 / 下载 / 新建文件夹 / 删除 / 重命名；目录递归传输
- **右键菜单**：远程（下载/重命名/删除/复制路径）+ 本地（上传/复制路径）+ 空白区（新建文件夹/刷新）
- 拖拽：系统文件拖入上传、本地行拖到远程栏上传、远程行拖到本地栏下载
- **断点续传**：传输中断后自动从断点继续；已完整则跳过、内容冲突则覆盖
- 传输队列：实时进度条、速率、**暂停 / 恢复 / 取消**、失败重试

### 端口转发（本地 / 远程 / 动态 SOCKS5）
- 规则 CRUD、启停、编辑，端口占用检测
- 本地转发：隧道双向拷贝
- 远程转发：服务端监听（`tcpip-forward`），连接经 `forwarded-tcpip` 通道转发到本地目标
- 动态代理：本地 SOCKS5，支持 IPv4 / 域名 / IPv6 目标

### 系统监控
- 右侧常驻面板：CPU / 内存 / 磁盘 / 网络速率 / 网络连接数（颜色分级）
- 监控详情页：指标卡 + CPU 实时曲线 + 磁盘分区详情 + 进程 Top
- 刷新间隔可在设置中调整（1 / 2 / 5 秒）

### 安全与设置
- 主密码（PBKDF2 + AES-256-GCM）加密会话密码 / 私钥密码，支持设置 / 修改 / 解锁 / 锁定 / 清除
- 深色 / 浅色 / 跟随系统主题、字号、光标样式、滚动缓冲区

> 说明：当前面向 **Linux 类服务器**（终端 / SFTP / 转发 / 监控均基于 Unix 命令）。远程 Windows 服务器（编码、监控兼容）暂未接入。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Tauri 2（复用系统 WebView） |
| 后端 | Rust（tokio + russh / russh-sftp / ring / rusqlite） |
| 前端 | React 18 + TypeScript + Vite + Zustand + xterm.js |
| 存储 | SQLite（rusqlite bundled） |
| 日志 | env_logger（`RUST_LOG=debug` 输出传输/转发细节） |

---

## 快速开始

```bash
# 1. 安装前端依赖
npm install

# 2. 开发运行（macOS 需在系统终端执行）
npm run tauri dev

# 3. 详细日志模式
RUST_LOG=debug npm run tauri dev

# 4. 构建安装包（macOS .dmg / Windows .msi）
npm run tauri build
```

### 运行单元测试

```bash
cd src-tauri && cargo test
```

> 网络类功能（SSH / SFTP）依赖真实服务器，未做集成测试。

---

## 项目结构

```
Termix/
├── design/                  # PRD 与设计原型
├── docs/                    # 开发进度、PRD 完成度总结
├── src/                     # 前端（React + TS）
│   ├── components/          # 标题栏 / 活动导航 / 终端 / SFTP / 转发 / 监控 / 设置等
│   ├── store/app.ts         # zustand 全局状态
│   ├── lib/                 # IPC 封装、终端注册表、共享设置
│   ├── styles/              # 设计 token + 全局样式（深/浅主题）
│   └── assets/icons/        # SVG 图标
└── src-tauri/               # 后端（Rust）
    ├── src/
    │   ├── main.rs          # 入口、命令注册、日志初始化
    │   ├── commands.rs      # Tauri IPC 命令
    │   ├── crypto.rs        # 主密码加密（PBKDF2 + AES-256-GCM）
    │   ├── ssh.rs           # SSH 连接 / 终端 channel / 远程转发回调
    │   ├── sftp.rs          # SFTP 操作 + 传输任务队列（断点续传 / 暂停恢复）
    │   ├── forward.rs       # 端口转发（本地 / 远程 / 动态 SOCKS5）
    │   ├── db.rs            # SQLite（会话/分组/历史/片段/转发/设置）
    │   └── models.rs        # 数据模型
    └── Cargo.toml
```

---

## 相关文档

- [开发进度](docs/开发进度.md)
- [PRD 完成度总结](docs/PRD完成度总结.md)
