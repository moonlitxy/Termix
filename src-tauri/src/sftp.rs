use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::ssh::SshManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
    pub perms: Option<u32>,
    /// 数值 uid（服务端未返回时为 None）
    pub uid: Option<u32>,
    /// 数值 gid
    pub gid: Option<u32>,
    /// 用户名（由 /etc/passwd 映射，映射不可用时为 None）
    pub user_name: Option<String>,
    /// 组名（由 /etc/group 映射）
    pub group_name: Option<String>,
}

/// 服务端 uid/gid → 名称映射（按连接懒加载并缓存）。
#[derive(Default, Clone)]
struct IdMap {
    users: std::collections::HashMap<u32, String>,
    groups: std::collections::HashMap<u32, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTask {
    pub id: String,
    pub session_id: String,
    pub connection_id: String,
    pub file_name: String,
    pub direction: String,
    pub local_path: String,
    pub remote_path: String,
    pub status: String,
    pub progress: f64,
    pub speed: f64,
    /// 已传输字节数与源文件总字节数：用于进度条下方的「12.3 MB / 48.0 MB」
    pub transferred_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
    pub is_dir: bool,
    /// 创建时间（毫秒），队列按新到旧展示
    pub created_at: u64,
}

/// 传输任务的取消/暂停标志（与全局注册表共享的 Arc 句柄）。
struct TransferFlags {
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
}

/// 传输进度共享计数器：传输循环实时写入，任务结束时据此生成准确的暂停进度。
#[derive(Default)]
struct TransferMeter {
    transferred: AtomicU64,
    total: AtomicU64,
}

/// 断点续传校验信息。
///
/// 下载时与半成品放在同一目录（`<目标>.termix-part.json`），上传时放在系统临时目录。
/// 续传前必须同时匹配源文件路径、大小、mtime 和首段 SHA-256，避免把另一个同名/同大小
/// 文件的内容接到半成品后面。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferMeta {
    version: u32,
    direction: String,
    /// 下载为远端源文件，上传为本地源文件
    source_path: String,
    /// 下载为本地最终文件，上传为远端最终文件
    final_path: String,
    /// 实际追加写入的半成品路径
    part_path: String,
    source_size: u64,
    source_mtime: i64,
    /// 源文件首段 SHA-256（十六进制）
    source_hash: String,
    /// 已确认写入半成品的字节数
    transferred: u64,
}

const META_VERSION: u32 = 1;
/// 文件身份校验读取的首段长度（64 KiB），兼顾准确性与开销
const HASH_PREFIX_LEN: u64 = 64 * 1024;
const DOWNLOAD_PART_SUFFIX: &str = ".termix-part";

/// 校验半成品时只比较已落盘的部分，避免小于 64 KiB 的文件把
/// 「源文件前 64 KiB 哈希」与「半成品全部内容哈希」错误对比。
fn check_hash_len(total: u64, transferred: u64) -> u64 {
    transferred.min(HASH_PREFIX_LEN).min(total)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 判断错误是否更像连接/通道中断，而不是权限、磁盘等永久性失败。
fn looks_like_connection_loss(message: &str) -> bool {
    let lower = message.to_lowercase();
    [
        "connection",
        "channel",
        "eof",
        "broken pipe",
        "not connected",
        "channel closed",
        "connection closed",
        "session closed",
        "reset",
        "timed out",
        "timeout",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn file_mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn sha256_hex(data: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, data)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 稳定的 FNV-1a 哈希：用于临时目录中的上传元数据文件名，跨进程重启保持一致。
fn stable_key(value: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn download_part_path(local_path: &str) -> PathBuf {
    PathBuf::from(format!("{local_path}{DOWNLOAD_PART_SUFFIX}"))
}

fn download_meta_path(local_path: &str) -> PathBuf {
    PathBuf::from(format!("{local_path}{DOWNLOAD_PART_SUFFIX}.json"))
}

fn upload_part_path(remote_path: &str) -> String {
    format!("{remote_path}.termix-part")
}

fn upload_meta_path(local_path: &str, remote_path: &str, session_id: &str) -> PathBuf {
    std::env::temp_dir().join("termix-transfers").join(format!(
        "{}.json",
        stable_key(&format!("{session_id}\0{local_path}\0{remote_path}"))
    ))
}

fn load_meta(path: &Path) -> Option<TransferMeta> {
    let data = std::fs::read(path).ok()?;
    match serde_json::from_slice::<TransferMeta>(&data) {
        Ok(meta) => Some(meta),
        Err(e) => {
            log::warn!("sftp: ignore invalid transfer metadata {path:?}: {e}");
            None
        }
    }
}

fn write_meta(path: &Path, meta: &TransferMeta) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create transfer metadata dir failed: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(meta)
        .map_err(|e| format!("serialize transfer metadata failed: {e}"))?;
    std::fs::write(&tmp, data).map_err(|e| format!("write transfer metadata failed: {e}"))?;
    // Windows 上 rename 不能覆盖已存在的文件，先删除旧文件再落盘
    let _ = std::fs::remove_file(path);
    std::fs::rename(&tmp, path).map_err(|e| format!("save transfer metadata failed: {e}"))?;
    Ok(())
}

async fn local_prefix_hash(path: &Path, limit: u64) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("open local file {path:?} failed: {e}"))?;
    let mut buf = vec![0u8; limit as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = file
            .read(&mut buf[filled..])
            .await
            .map_err(|e| format!("read local file {path:?} failed: {e}"))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(sha256_hex(&buf[..filled]))
}

async fn remote_prefix_hash(sftp: &SftpSession, path: &str, limit: u64) -> Result<String, String> {
    let mut file = sftp
        .open(path)
        .await
        .map_err(|e| format!("open remote file {path} failed: {e}"))?;
    let mut buf = vec![0u8; limit as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = file
            .read(&mut buf[filled..])
            .await
            .map_err(|e| format!("read remote file {path} failed: {e}"))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    let _ = file.shutdown().await;
    Ok(sha256_hex(&buf[..filled]))
}

fn replace_local_part(part: &Path, dest: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        if Path::new(dest).exists() {
            let backup = format!("{dest}.termix-bak");
            let _ = std::fs::remove_file(&backup);
            std::fs::rename(dest, &backup)
                .map_err(|e| format!("backup previous local file failed: {e}"))?;
            return match std::fs::rename(part, dest) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&backup);
                    Ok(())
                }
                Err(e) => {
                    let _ = std::fs::rename(&backup, dest);
                    Err(format!("move downloaded file into place failed: {e}"))
                }
            };
        }
    }
    std::fs::rename(part, dest).map_err(|e| format!("move downloaded file into place failed: {e}"))
}

/// 远端替换：先把旧目标改名为备份，再提交半成品；失败时回滚，避免 rename
/// 在目标已存在时失败（SFTP v3 的 RENAME 语义）导致旧文件被提前删除。
async fn replace_remote_file(sftp: &SftpSession, part: &str, dest: &str) -> Result<(), String> {
    let backup = format!("{dest}.termix-bak");
    let had_target = sftp.metadata(dest).await.is_ok();
    if had_target {
        let _ = sftp.remove_file(&backup).await;
        if let Err(e) = sftp.rename(dest, &backup).await {
            return Err(format!("backup remote target failed: {e}"));
        }
    }
    match sftp.rename(part, dest).await {
        Ok(()) => {
            if had_target {
                let _ = sftp.remove_file(&backup).await;
            }
            Ok(())
        }
        Err(e) => {
            if had_target {
                let _ = sftp.rename(&backup, dest).await;
            }
            Err(format!("commit remote upload failed: {e}"))
        }
    }
}

fn meta_matches_download(
    meta: &TransferMeta,
    remote_path: &str,
    local_path: &str,
    part_path: &str,
    total: u64,
    remote_mtime: i64,
    source_hash: &str,
) -> bool {
    meta.version == META_VERSION
        && meta.direction == "download"
        && meta.source_path == remote_path
        && meta.final_path == local_path
        && meta.part_path == part_path
        && meta.source_size == total
        && meta.source_mtime == remote_mtime
        && meta.source_hash == source_hash
        && meta.transferred <= total
}

fn meta_matches_upload(
    meta: &TransferMeta,
    local_path: &str,
    remote_path: &str,
    part_path: &str,
    total: u64,
    local_mtime: i64,
    source_hash: &str,
) -> bool {
    meta.version == META_VERSION
        && meta.direction == "upload"
        && meta.source_path == local_path
        && meta.final_path == remote_path
        && meta.part_path == part_path
        && meta.source_size == total
        && meta.source_mtime == local_mtime
        && meta.source_hash == source_hash
        && meta.transferred <= total
}

pub struct SftpService {
    ssh: Arc<SshManager>,
    sessions: Mutex<HashMap<String, Arc<SftpSession>>>,
    tasks: Arc<Mutex<HashMap<String, TransferTask>>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pauses: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// 已被删除/清空但后台循环尚未退出的任务：抑制其终止事件，避免重新出现在队列里。
    removed_tasks: Arc<Mutex<HashSet<String>>>,
    /// 连接 → uid/gid 名称映射缓存
    idmap: Mutex<HashMap<String, IdMap>>,
}

impl SftpService {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self {
            ssh,
            sessions: Mutex::new(HashMap::new()),
            tasks: Arc::new(Mutex::new(HashMap::new())),
            cancels: Arc::new(Mutex::new(HashMap::new())),
            pauses: Arc::new(Mutex::new(HashMap::new())),
            removed_tasks: Arc::new(Mutex::new(HashSet::new())),
            idmap: Mutex::new(HashMap::new()),
        }
    }

    async fn session(&self, connection_id: &str) -> Result<Arc<SftpSession>, String> {
        if let Some(s) = self.sessions.lock().await.get(connection_id) {
            log::debug!("sftp: reuse cached session for connection {connection_id}");
            return Ok(s.clone());
        }
        let handle = self.ssh.get_handle(connection_id).await.ok_or_else(|| {
            log::warn!("sftp: session requested for unknown connection {connection_id}");
            "connection not found".to_string()
        })?;
        log::info!("sftp: opening SFTP subsystem for connection {connection_id}");
        let channel = handle.channel_open_session().await.map_err(|e| {
            log::error!("sftp: open channel failed for {connection_id}: {e}");
            format!("open channel failed: {e}")
        })?;
        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            log::error!("sftp: request subsystem failed for {connection_id}: {e}");
            format!("request subsystem failed: {e}")
        })?;
        let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| {
            log::error!("sftp: init failed for {connection_id}: {e}");
            format!("sftp init failed: {e}")
        })?;
        let sftp = Arc::new(sftp);
        log::info!("sftp: SFTP session established for connection {connection_id}");
        self.sessions
            .lock()
            .await
            .insert(connection_id.to_string(), sftp.clone());
        Ok(sftp)
    }

    pub async fn cwd(&self, connection_id: &str) -> Result<String, String> {
        let sftp = self.session(connection_id).await?;
        let cwd = sftp.canonicalize(".").await.map_err(|e| {
            log::error!("sftp: cwd failed conn={connection_id}: {e}");
            format!("cwd failed: {e}")
        })?;
        log::debug!("sftp: cwd conn={connection_id} -> {cwd}");
        Ok(cwd)
    }

    pub async fn list(&self, connection_id: &str, path: &str) -> Result<Vec<SftpItem>, String> {
        self.list_inner(connection_id, path, false).await
    }

    /// 带补充信息的目录列表：目录真实占用与 uid/gid 名称映射。
    /// `du` 需要递归统计目录，耗时不可控，因此只供前端后台二次刷新使用，
    /// 不能阻塞首次文件列表展示。
    pub async fn list_enriched(
        &self,
        connection_id: &str,
        path: &str,
    ) -> Result<Vec<SftpItem>, String> {
        self.list_inner(connection_id, path, true).await
    }

    async fn list_inner(
        &self,
        connection_id: &str,
        path: &str,
        enriched: bool,
    ) -> Result<Vec<SftpItem>, String> {
        let sftp = self.session(connection_id).await?;
        let entries = sftp.read_dir(path).await.map_err(|e| {
            log::error!("sftp: list failed conn={connection_id} path={path}: {e}");
            format!("read_dir failed: {e}")
        })?;
        let mut items = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            let meta = entry.metadata();
            items.push(SftpItem {
                name: name.clone(),
                path: entry.path(),
                is_dir: meta.is_dir(),
                size: meta.len(),
                mtime: meta.mtime.unwrap_or(0) as i64,
                perms: meta.permissions,
                uid: meta.uid,
                gid: meta.gid,
                user_name: None,
                group_name: None,
            });
        }
        sort_items(&mut items);
        if enriched {
            // 补充信息：目录真实占用（du）与 uid/gid 名称映射（失败静默降级）
            self.enrich(connection_id, path, &mut items).await;
        }
        log::debug!(
            "sftp: list conn={connection_id} path={path} -> {} entries",
            items.len()
        );
        Ok(items)
    }

    /// 为列表补充目录占用大小与用户/组名称。
    /// - 目录大小：SFTP 协议仅返回目录自身元数据（约 4KB），
    ///   用 `du -sb <path>/*` 获取子项真实占用字节数；
    /// - 用户/组：读取 /etc/passwd、/etc/group 构建 uid/gid → 名称映射并缓存。
    /// 任一步失败（权限/超时/命令不存在）都静默忽略，保留原始数据。
    async fn enrich(&self, connection_id: &str, path: &str, items: &mut [SftpItem]) {
        let need_du = items.iter().any(|i| i.is_dir);
        let need_idmap = items.iter().any(|i| i.uid.is_some() || i.gid.is_some());
        if !need_du && !need_idmap {
            return;
        }
        // 组装一条命令，用唯一标记分隔三段输出
        let mut cmd = String::new();
        if need_du {
            let quoted = path.replace('\'', "'\\''");
            cmd.push_str(&format!("du -sb '{quoted}'/* 2>/dev/null"));
        }
        if need_idmap {
            if !cmd.is_empty() {
                cmd.push_str("; echo __TERMIX_SEP__; ");
            }
            cmd.push_str(
                "cat /etc/passwd 2>/dev/null; echo __TERMIX_SEP__; cat /etc/group 2>/dev/null",
            );
        }
        let out = match self.ssh.exec_command(connection_id, &cmd).await {
            Ok(o) => o,
            Err(_) => return,
        };
        let parts: Vec<&str> = out.split("__TERMIX_SEP__").collect();
        if need_du {
            for line in parts.first().unwrap_or(&"").lines() {
                if let Some((size_s, full)) = line.rsplit_once('\t') {
                    if let (Ok(size), Some(name)) =
                        (size_s.trim().parse::<u64>(), full.rsplit('/').next())
                    {
                        if let Some(it) = items.iter_mut().find(|i| i.is_dir && i.name == name) {
                            it.size = size;
                        }
                    }
                }
            }
        }
        if need_idmap {
            let map = IdMap {
                users: parse_passwd_map(parts.get(1).copied().unwrap_or("")),
                groups: parse_group_map(parts.get(2).copied().unwrap_or("")),
            };
            self.idmap
                .lock()
                .await
                .insert(connection_id.to_string(), map.clone());
            for it in items.iter_mut() {
                it.user_name = it.uid.and_then(|u| map.users.get(&u).cloned());
                it.group_name = it.gid.and_then(|g| map.groups.get(&g).cloned());
            }
        }
    }

    pub async fn mkdir(&self, connection_id: &str, path: &str) -> Result<(), String> {
        let sftp = self.session(connection_id).await?;
        log::info!("sftp: mkdir conn={connection_id} path={path}");
        sftp.create_dir(path).await.map_err(|e| {
            log::error!("sftp: mkdir failed conn={connection_id} path={path}: {e}");
            e.to_string()
        })
    }

    /// 新建空文件：以 CREATE|TRUNCATE|WRITE 打开后立即关闭。
    pub async fn create_file(&self, connection_id: &str, path: &str) -> Result<(), String> {
        let sftp = self.session(connection_id).await?;
        log::info!("sftp: create_file conn={connection_id} path={path}");
        let file = sftp
            .open_with_flags(
                path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| {
                log::error!("sftp: create_file open failed conn={connection_id} path={path}: {e}");
                format!("create file failed: {e}")
            })?;
        file.close().await.map_err(|e| {
            log::error!("sftp: create_file close failed conn={connection_id} path={path}: {e}");
            format!("close file failed: {e}")
        })
    }

    pub async fn remove(
        &self,
        connection_id: &str,
        path: &str,
        is_dir: bool,
    ) -> Result<(), String> {
        let sftp = self.session(connection_id).await?;
        log::info!("sftp: remove conn={connection_id} path={path} is_dir={is_dir}");
        if is_dir {
            sftp.remove_dir(path).await.map_err(|e| {
                log::error!("sftp: remove_dir failed conn={connection_id} path={path}: {e}");
                e.to_string()
            })
        } else {
            sftp.remove_file(path).await.map_err(|e| {
                log::error!("sftp: remove_file failed conn={connection_id} path={path}: {e}");
                e.to_string()
            })
        }
    }

    pub async fn rename(
        &self,
        connection_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), String> {
        let sftp = self.session(connection_id).await?;
        log::info!("sftp: rename conn={connection_id} {old_path} -> {new_path}");
        sftp.rename(old_path, new_path).await.map_err(|e| {
            log::error!("sftp: rename failed conn={connection_id} {old_path} -> {new_path}: {e}");
            e.to_string()
        })
    }

    pub async fn chmod(&self, connection_id: &str, path: &str, mode: u32) -> Result<(), String> {
        let sftp = self.session(connection_id).await?;
        let attrs = russh_sftp::protocol::FileAttributes {
            permissions: Some(mode),
            ..Default::default()
        };
        log::info!("sftp: chmod conn={connection_id} path={path} mode={mode:o}");
        sftp.set_metadata(path, attrs).await.map_err(|e| {
            log::error!("sftp: chmod failed conn={connection_id} path={path}: {e}");
            e.to_string()
        })
    }

    /// 传输任务的取消/暂停标志（与全局注册表共享的 Arc 句柄）。
    async fn register_flags(&self, task_id: &str) -> TransferFlags {
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = Arc::new(AtomicBool::new(false));
        self.cancels
            .lock()
            .await
            .insert(task_id.to_string(), cancel.clone());
        self.pauses
            .lock()
            .await
            .insert(task_id.to_string(), pause.clone());
        TransferFlags { cancel, pause }
    }

    /// 启动传输后台任务：注册标志、spawn、统一处理完成/失败/暂停/取消的结果状态与进度推送。
    async fn spawn_transfer<F, Fut>(
        &self,
        sftp: Arc<SftpSession>,
        mut task: TransferTask,
        app: AppHandle,
        run: F,
    ) -> Result<String, String>
    where
        F: FnOnce(
                Arc<SftpSession>,
                Arc<AtomicBool>,
                Arc<AtomicBool>,
                AppHandle,
                Arc<TransferMeter>,
            ) -> Fut
            + Send
            + 'static,
        Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,
    {
        let tid = task.id.clone();
        let fname = task.file_name.clone();
        let dir = task.direction.clone();
        let session_id = task.session_id.clone();
        let connection_id = task.connection_id.clone();
        let local_path = task.local_path.clone();
        let remote_path = task.remote_path.clone();
        let is_dir = task.is_dir;
        let created_at = task.created_at;
        let resume_progress = task.progress;
        let resume_transferred = task.transferred_bytes;
        let resume_total = task.total_bytes;
        task.status = "running".into();
        task.error = None;
        self.tasks.lock().await.insert(tid.clone(), task);

        // 立即推送完整任务信息，前端无需等到第一次进度事件才创建行，
        // 也避免新任务缺少本地/远端路径。
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "taskId": tid,
                "fileName": fname,
                "direction": dir,
                "sessionId": session_id,
                "connectionId": connection_id,
                "localPath": local_path,
                "remotePath": remote_path,
                "isDir": is_dir,
                "createdAt": created_at,
                "progress": resume_progress,
                "speed": 0.0,
                "status": "running",
                "transferredBytes": resume_transferred,
                "totalBytes": resume_total,
            }),
        );

        let flags = self.register_flags(&tid).await;
        let tasks = self.tasks.clone();
        let cancels = self.cancels.clone();
        let pauses = self.pauses.clone();
        let removed_tasks = self.removed_tasks.clone();
        let ssh = self.ssh.clone();
        let emit_app = app.clone();
        let tid_inner = tid.clone();
        let cancel_inner = flags.cancel.clone();
        let pause_inner = flags.pause.clone();
        let meter = Arc::new(TransferMeter::default());
        let meter_inner = meter.clone();
        tokio::spawn(async move {
            let result = run(
                sftp,
                cancel_inner.clone(),
                pause_inner.clone(),
                app,
                meter_inner,
            )
            .await;
            let total = meter.total.load(Ordering::Relaxed);
            let transferred = if total > 0 {
                meter.transferred.load(Ordering::Relaxed).min(total)
            } else {
                meter.transferred.load(Ordering::Relaxed)
            };
            let progress = if total > 0 {
                (transferred as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            let was_removed = removed_tasks.lock().await.remove(&tid_inner);
            let keep_for_resume = if was_removed {
                log::info!("sftp: {dir} task {tid_inner} removed by user; suppress terminal event");
                false
            } else {
                match result {
                    Ok(()) => {
                        log::info!("sftp: {dir} task {tid_inner} completed");
                        set_task(&tasks, &tid_inner, |t| {
                            t.status = "completed".into();
                            t.progress = 100.0;
                            if t.total_bytes > 0 {
                                t.transferred_bytes = t.total_bytes;
                            }
                        })
                        .await;
                        let _ = emit_app.emit(
                            "transfer-progress",
                            serde_json::json!({
                                "taskId": tid_inner, "fileName": fname, "direction": dir,
                                "sessionId": session_id, "connectionId": connection_id,
                                "localPath": local_path,
                                "remotePath": remote_path, "isDir": is_dir,
                                "createdAt": created_at,
                                "progress": 100.0, "speed": 0.0, "status": "completed",
                                "transferredBytes": total, "totalBytes": total,
                            }),
                        );
                        false
                    }
                    Err(e) => {
                        let status = if pause_inner.load(Ordering::Relaxed) {
                            "paused"
                        } else if cancel_inner.load(Ordering::Relaxed) {
                            "cancelled"
                        } else if !is_dir
                            && (ssh.get_handle(&connection_id).await.is_none()
                                || looks_like_connection_loss(&e))
                        {
                            // 连接已断开：保留半成品与元数据，重连后可继续，
                            // 不能按普通失败在 60 秒后清理。
                            "interrupted"
                        } else {
                            "failed"
                        };
                        let msg = format!("{dir} {status}: {e}");
                        if status == "failed" || status == "interrupted" {
                            log::error!("sftp: {dir} task {tid_inner} failed: {e}");
                        } else {
                            log::info!("sftp: {dir} task {tid_inner} {status}");
                        }
                        set_task(&tasks, &tid_inner, |t| {
                            t.status = status.into();
                            t.error = Some(msg.clone());
                            t.progress = progress;
                            t.transferred_bytes = transferred;
                            t.total_bytes = total;
                        })
                        .await;
                        let _ = emit_app.emit(
                            "transfer-progress",
                            serde_json::json!({
                                "taskId": tid_inner, "fileName": fname, "direction": dir,
                                "sessionId": session_id, "connectionId": connection_id,
                                "localPath": local_path,
                                "remotePath": remote_path, "isDir": is_dir,
                                "createdAt": created_at,
                                "progress": progress, "speed": 0.0, "status": status,
                                "error": msg, "transferredBytes": transferred,
                                "totalBytes": total,
                            }),
                        );
                        status == "paused" || status == "interrupted"
                    }
                }
            };
            if !keep_for_resume {
                cancels.lock().await.remove(&tid_inner);
                pauses.lock().await.remove(&tid_inner);
            }
        });
        Ok(tid)
    }

    pub async fn upload(
        &self,
        app: AppHandle,
        connection_id: &str,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
    ) -> Result<String, String> {
        if self
            .has_active_duplicate("upload", session_id, local_path, remote_path)
            .await
        {
            return Err("该文件已有正在进行的上传任务".into());
        }
        let sftp = self.session(connection_id).await?;
        let task_id = uuid::Uuid::new_v4().to_string();
        let file_name = Path::new(local_path)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| local_path.to_string());
        log::info!(
            "sftp: upload task {task_id} conn={connection_id} session={session_id} local={local_path} remote={remote_path}"
        );
        let task = TransferTask {
            id: task_id.clone(),
            session_id: session_id.to_string(),
            connection_id: connection_id.to_string(),
            file_name: file_name.clone(),
            direction: "upload".into(),
            local_path: local_path.to_string(),
            remote_path: remote_path.to_string(),
            status: "running".into(),
            progress: 0.0,
            speed: 0.0,
            transferred_bytes: 0,
            total_bytes: 0,
            error: None,
            is_dir: false,
            created_at: now_ms(),
        };
        let local = local_path.to_string();
        let remote = remote_path.to_string();
        let sid = session_id.to_string();
        self.spawn_transfer(
            sftp,
            task,
            app,
            move |sftp, cancel, pause, app, meter| async move {
                transfer_upload(
                    &sftp, &local, &remote, &sid, &task_id, &cancel, &pause, &app, &meter,
                )
                .await
            },
        )
        .await
    }

    pub async fn download(
        &self,
        app: AppHandle,
        connection_id: &str,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
    ) -> Result<String, String> {
        if self
            .has_active_duplicate("download", session_id, local_path, remote_path)
            .await
        {
            return Err("该文件已有正在进行的下载任务".into());
        }
        let sftp = self.session(connection_id).await?;
        let task_id = uuid::Uuid::new_v4().to_string();
        let file_name = Path::new(remote_path)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| remote_path.to_string());
        log::info!(
            "sftp: download task {task_id} conn={connection_id} session={session_id} remote={remote_path} local={local_path}"
        );
        let task = TransferTask {
            id: task_id.clone(),
            session_id: session_id.to_string(),
            connection_id: connection_id.to_string(),
            file_name: file_name.clone(),
            direction: "download".into(),
            local_path: local_path.to_string(),
            remote_path: remote_path.to_string(),
            status: "running".into(),
            progress: 0.0,
            speed: 0.0,
            transferred_bytes: 0,
            total_bytes: 0,
            error: None,
            is_dir: false,
            created_at: now_ms(),
        };
        let local = local_path.to_string();
        let remote = remote_path.to_string();
        self.spawn_transfer(
            sftp,
            task,
            app,
            move |sftp, cancel, pause, app, meter| async move {
                transfer_download(
                    &sftp, &remote, &local, &task_id, &cancel, &pause, &app, &meter,
                )
                .await
            },
        )
        .await
    }

    async fn has_active_duplicate(
        &self,
        direction: &str,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
    ) -> bool {
        let tasks = self.tasks.lock().await;
        tasks.values().any(|t| {
            if t.direction != direction
                || !matches!(t.status.as_str(), "running" | "paused" | "interrupted")
            {
                return false;
            }
            // 下载共用本地半成品路径，必须按本地目标去重（即使来源服务器不同）；
            // 上传则只在同一会话内阻止相同源/目标，避免误伤不同服务器。
            if direction == "download" {
                t.local_path == local_path
            } else {
                t.session_id == session_id
                    && t.local_path == local_path
                    && t.remote_path == remote_path
            }
        })
    }

    /// 暂停任务：置位暂停标志，传输循环会尽快退出并保留半成品文件。
    /// 目录传输不支持暂停（无断点续传语义），明确拒绝。
    pub async fn transfer_pause(&self, task_id: &str) -> Result<(), String> {
        let task = self.tasks.lock().await.get(task_id).cloned();
        if let Some(t) = &task {
            if t.is_dir {
                log::warn!("sftp: pause task {task_id} is a directory transfer, unsupported");
                return Err("目录传输不支持暂停".into());
            }
        }
        let mut paused = false;
        if let Some(p) = self.pauses.lock().await.get(task_id) {
            p.store(true, Ordering::Relaxed);
            paused = true;
        }
        if paused {
            log::info!("sftp: pause requested for task {task_id}");
        } else {
            log::warn!("sftp: pause task {task_id} not found or already finished");
            return Err("任务不存在或已结束".into());
        }
        Ok(())
    }

    /// 恢复任务：基于已保留的半成品走断点续传继续传输。
    /// `connection_id` 为前端传入的重连后新连接 id；为空时沿用原连接（用户手动暂停）。
    pub async fn transfer_resume(
        &self,
        app: AppHandle,
        task_id: &str,
        connection_id: Option<String>,
    ) -> Result<(), String> {
        let mut task = self
            .tasks
            .lock()
            .await
            .get(task_id)
            .cloned()
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != "paused" && task.status != "interrupted" {
            log::warn!(
                "sftp: resume task {task_id} not resumable in state ({})",
                task.status
            );
            return Err("仅可恢复已暂停或连接中断的任务".into());
        }
        if let Some(new_id) = connection_id.filter(|id| !id.is_empty()) {
            if new_id != task.connection_id {
                log::info!(
                    "sftp: resume task {task_id} switch connection {} -> {new_id}",
                    task.connection_id
                );
                task.connection_id = new_id;
            }
        }
        let sftp = self.session(&task.connection_id).await?;
        log::info!("sftp: resume task {task_id} ({})", task.direction);
        let direction = task.direction.clone();
        let local = task.local_path.clone();
        let remote = task.remote_path.clone();
        let sid = task.session_id.clone();
        let tid = task_id.to_string();
        self.spawn_transfer(
            sftp,
            task,
            app,
            move |sftp, cancel, pause, app, meter| async move {
                if direction == "upload" {
                    transfer_upload(
                        &sftp, &local, &remote, &sid, &tid, &cancel, &pause, &app, &meter,
                    )
                    .await
                } else {
                    transfer_download(&sftp, &remote, &local, &tid, &cancel, &pause, &app, &meter)
                        .await
                }
            },
        )
        .await?;
        Ok(())
    }

    pub async fn transfer_list(&self) -> Result<Vec<TransferTask>, String> {
        let tasks = self.tasks.lock().await;
        let mut list: Vec<TransferTask> = tasks.values().cloned().collect();
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        log::debug!("sftp: transfer_list -> {} tasks", list.len());
        Ok(list)
    }

    /// 递归上传整个目录。
    pub async fn upload_dir(
        &self,
        app: AppHandle,
        connection_id: &str,
        session_id: &str,
        local_dir: &str,
        remote_dir: &str,
    ) -> Result<String, String> {
        let sftp = self.session(connection_id).await?;
        let task_id = uuid::Uuid::new_v4().to_string();
        let file_name = Path::new(local_dir)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| local_dir.to_string());
        log::info!(
            "sftp: upload-dir task {task_id} conn={connection_id} local={local_dir} remote={remote_dir}"
        );
        let task = TransferTask {
            id: task_id.clone(),
            session_id: session_id.to_string(),
            connection_id: connection_id.to_string(),
            file_name: file_name.clone(),
            direction: "upload".into(),
            local_path: local_dir.to_string(),
            remote_path: remote_dir.to_string(),
            status: "running".into(),
            progress: 0.0,
            speed: 0.0,
            transferred_bytes: 0,
            total_bytes: 0,
            error: None,
            is_dir: true,
            created_at: now_ms(),
        };
        let local = local_dir.to_string();
        let remote = remote_dir.to_string();
        self.spawn_transfer(
            sftp,
            task,
            app,
            move |sftp, cancel, _pause, app, _meter| async move {
                transfer_upload_dir(&sftp, &local, &remote, &task_id, &cancel, &app).await
            },
        )
        .await
    }

    /// 递归下载整个目录。
    pub async fn download_dir(
        &self,
        app: AppHandle,
        connection_id: &str,
        session_id: &str,
        remote_dir: &str,
        local_dir: &str,
    ) -> Result<String, String> {
        let sftp = self.session(connection_id).await?;
        let task_id = uuid::Uuid::new_v4().to_string();
        let file_name = Path::new(remote_dir)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| remote_dir.to_string());
        log::info!(
            "sftp: download-dir task {task_id} conn={connection_id} remote={remote_dir} local={local_dir}"
        );
        let task = TransferTask {
            id: task_id.clone(),
            session_id: session_id.to_string(),
            connection_id: connection_id.to_string(),
            file_name: file_name.clone(),
            direction: "download".into(),
            local_path: local_dir.to_string(),
            remote_path: remote_dir.to_string(),
            status: "running".into(),
            progress: 0.0,
            speed: 0.0,
            transferred_bytes: 0,
            total_bytes: 0,
            error: None,
            is_dir: true,
            created_at: now_ms(),
        };
        let local = local_dir.to_string();
        let remote = remote_dir.to_string();
        self.spawn_transfer(
            sftp,
            task,
            app,
            move |sftp, cancel, _pause, app, _meter| async move {
                transfer_download_dir(&sftp, &remote, &local, &task_id, &cancel, &app).await
            },
        )
        .await
    }

    /// 会话断开时释放 SFTP 会话缓存与用户/组映射缓存。
    pub async fn drop_session(&self, connection_id: &str) {
        self.idmap.lock().await.remove(connection_id);
        if let Some(s) = self.sessions.lock().await.remove(connection_id) {
            log::info!("sftp: closing SFTP session for connection {connection_id}");
            let _ = s.close().await;
        } else {
            log::debug!("sftp: no cached session to drop for {connection_id}");
        }
    }

    pub async fn transfer_cancel(&self, task_id: &str) -> Result<(), String> {
        let task = self
            .tasks
            .lock()
            .await
            .get(task_id)
            .cloned()
            .ok_or_else(|| "task not found or already finished".to_string())?;
        if !matches!(task.status.as_str(), "running" | "paused" | "interrupted") {
            log::warn!(
                "sftp: cancel task {task_id} in non-cancellable state {}",
                task.status
            );
            return Err("task not found or already finished".into());
        }
        if let Some(f) = self.cancels.lock().await.get(task_id) {
            f.store(true, Ordering::Relaxed);
        }
        log::info!("sftp: cancel transfer task {task_id}");
        // 暂停/中断的任务已没有运行中的循环，需要在这里直接清理半成品和状态。
        if task.status != "running" {
            self.cleanup_partial(&task).await;
            set_task(&self.tasks, task_id, |t| {
                t.status = "cancelled".into();
                t.error = None;
            })
            .await;
            self.cancels.lock().await.remove(task_id);
            self.pauses.lock().await.remove(task_id);
        }
        Ok(())
    }

    /// 从队列删除单个任务。进行中的任务会先取消，暂停/中断任务会清理半成品。
    pub async fn transfer_delete(&self, task_id: &str) -> Result<(), String> {
        let task = self
            .tasks
            .lock()
            .await
            .get(task_id)
            .cloned()
            .ok_or_else(|| "任务不存在".to_string())?;
        match task.status.as_str() {
            "running" => {
                if let Some(f) = self.cancels.lock().await.get(task_id) {
                    f.store(true, Ordering::Relaxed);
                }
                // 先登记再移除：后台循环退出时据此抑制 cancelled 事件，
                // 避免已删除的任务重新出现在前端队列。
                self.removed_tasks.lock().await.insert(task_id.to_string());
                self.tasks.lock().await.remove(task_id);
            }
            "paused" | "interrupted" => {
                if let Some(f) = self.cancels.lock().await.get(task_id) {
                    f.store(true, Ordering::Relaxed);
                }
                self.cleanup_partial(&task).await;
                self.tasks.lock().await.remove(task_id);
                self.cancels.lock().await.remove(task_id);
                self.pauses.lock().await.remove(task_id);
            }
            _ => {
                self.tasks.lock().await.remove(task_id);
            }
        }
        log::info!("sftp: deleted transfer task {task_id} ({})", task.status);
        Ok(())
    }

    /// 清空当前传输队列。进行中的任务会取消，暂停/中断任务会清理半成品。
    pub async fn transfer_clear(&self) -> Result<usize, String> {
        let tasks: Vec<TransferTask> = self.tasks.lock().await.values().cloned().collect();
        let count = tasks.len();
        for task in tasks {
            match task.status.as_str() {
                "running" => {
                    if let Some(f) = self.cancels.lock().await.get(&task.id) {
                        f.store(true, Ordering::Relaxed);
                    }
                    self.removed_tasks.lock().await.insert(task.id.clone());
                    self.tasks.lock().await.remove(&task.id);
                }
                "paused" | "interrupted" => {
                    if let Some(f) = self.cancels.lock().await.get(&task.id) {
                        f.store(true, Ordering::Relaxed);
                    }
                    self.cleanup_partial(&task).await;
                    self.tasks.lock().await.remove(&task.id);
                    self.cancels.lock().await.remove(&task.id);
                    self.pauses.lock().await.remove(&task.id);
                }
                _ => {
                    self.tasks.lock().await.remove(&task.id);
                }
            }
        }
        log::info!("sftp: cleared {count} transfer tasks");
        Ok(count)
    }

    /// 删除已保留的半成品与续传元数据（取消传输时调用）。
    async fn cleanup_partial(&self, task: &TransferTask) {
        if task.is_dir {
            return;
        }
        if task.direction == "download" {
            let part = download_part_path(&task.local_path);
            let _ = tokio::fs::remove_file(&part).await;
            let _ = std::fs::remove_file(download_meta_path(&task.local_path));
            log::info!("sftp: removed partial download {}", part.display());
        } else {
            let meta = upload_meta_path(&task.local_path, &task.remote_path, &task.session_id);
            let _ = std::fs::remove_file(&meta);
            if let Ok(sftp) = self.session(&task.connection_id).await {
                let part = upload_part_path(&task.remote_path);
                if let Err(e) = sftp.remove_file(&part).await {
                    log::debug!("sftp: remove partial upload {part} failed: {e}");
                }
            }
        }
    }
}

async fn transfer_upload(
    sftp: &SftpSession,
    local_path: &str,
    remote_path: &str,
    session_id: &str,
    task_id: &str,
    cancel: &AtomicBool,
    pause: &AtomicBool,
    app: &AppHandle,
    meter: &TransferMeter,
) -> Result<(), String> {
    let local_meta = tokio::fs::metadata(local_path).await.map_err(|e| {
        log::error!("sftp: upload[{task_id}] stat local failed {local_path}: {e}");
        format!("read local file failed: {e}")
    })?;
    let total = local_meta.len();
    let local_mtime = file_mtime_secs(&local_meta);
    meter.total.store(total, Ordering::Relaxed);

    let source_hash = local_prefix_hash(Path::new(local_path), HASH_PREFIX_LEN)
        .await
        .map_err(|e| {
            log::error!("sftp: upload[{task_id}] hash local prefix failed: {e}");
            e
        })?;

    let part_path = upload_part_path(remote_path);
    let meta_path = upload_meta_path(local_path, remote_path, session_id);
    let mut offset = 0u64;
    let mut restart_notice = false;

    if let Some(meta) = load_meta(&meta_path) {
        if meta_matches_upload(
            &meta,
            local_path,
            remote_path,
            &part_path,
            total,
            local_mtime,
            &source_hash,
        ) {
            match sftp.metadata(&part_path).await {
                Ok(part_meta) if part_meta.len() >= meta.transferred => {
                    // 半成品前缀必须与本地源文件首段一致，避免把别的文件续接进来
                    let prefix_ok = if meta.transferred == 0 {
                        true
                    } else {
                        let check_len = check_hash_len(total, meta.transferred);
                        match (
                            local_prefix_hash(Path::new(local_path), check_len).await,
                            remote_prefix_hash(sftp, &part_path, check_len).await,
                        ) {
                            (Ok(local), Ok(remote)) => local == remote,
                            _ => false,
                        }
                    };
                    if prefix_ok {
                        offset = meta.transferred;
                        if part_meta.len() > offset {
                            // 崩溃时可能已写入但未更新检查点：截断到可信长度
                            let attrs = FileAttributes {
                                size: Some(offset),
                                ..Default::default()
                            };
                            if let Err(e) = sftp.set_metadata(&part_path, attrs).await {
                                log::warn!(
                                    "sftp: upload[{task_id}] truncate part to {offset} failed: {e}"
                                );
                                offset = 0;
                            }
                        }
                    }
                }
                Ok(_) => {
                    log::warn!(
                        "sftp: upload[{task_id}] part shorter than checkpoint, restart from zero"
                    );
                }
                Err(_) => {
                    log::info!("sftp: upload[{task_id}] part file missing, start from zero");
                }
            }
        }
        if offset == 0 {
            if meta.transferred > 0 {
                restart_notice = true;
                log::warn!(
                    "sftp: upload[{task_id}] previous transfer cannot be verified, restart from zero"
                );
            }
            let _ = sftp.remove_file(&part_path).await;
            let _ = std::fs::remove_file(&meta_path);
        }
    } else {
        // 没有校验元数据：远端最终文件大小完全一致时按已完成处理，保留旧行为；
        // 否则任何半成品都无法确认来源，删除后重传。
        if let Ok(remote_meta) = sftp.metadata(remote_path).await {
            let remote_mtime = remote_meta.mtime.unwrap_or(0) as i64;
            if remote_meta.len() == total && total > 0 && remote_mtime >= local_mtime {
                log::info!(
                    "sftp: upload[{task_id}] remote already complete ({total} bytes), skip transfer"
                );
                meter.transferred.store(total, Ordering::Relaxed);
                return Ok(());
            }
        }
        if sftp.metadata(&part_path).await.is_ok() {
            restart_notice = true;
            let _ = sftp.remove_file(&part_path).await;
        }
    }

    if offset > 0 {
        log::info!("sftp: upload[{task_id}] verified resume from offset={offset} bytes");
    } else {
        log::info!("sftp: upload[{task_id}] start total={total} bytes");
        if restart_notice {
            let _ = app.emit(
                "transfer-progress",
                serde_json::json!({
                    "taskId": task_id, "status": "running", "progress": 0.0,
                    "speed": 0.0, "transferredBytes": 0, "totalBytes": total,
                    "restarted": true,
                }),
            );
        }
        // 本次从头写入，确保半成品为空；最终远端文件在提交前保持不变
        let _ = sftp.remove_file(&part_path).await;
    }

    write_meta(
        &meta_path,
        &TransferMeta {
            version: META_VERSION,
            direction: "upload".into(),
            source_path: local_path.to_string(),
            final_path: remote_path.to_string(),
            part_path: part_path.clone(),
            source_size: total,
            source_mtime: local_mtime,
            source_hash: source_hash.clone(),
            transferred: offset,
        },
    )?;
    let start_progress = if total > 0 {
        (offset as f64 / total as f64) * 100.0
    } else {
        0.0
    };
    let _ = app.emit(
        "transfer-progress",
        serde_json::json!({
            "taskId": task_id, "status": "running", "progress": start_progress,
            "speed": 0.0, "transferredBytes": offset, "totalBytes": total,
        }),
    );

    if total == 0 {
        let file = sftp
            .open_with_flags(
                &part_path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| format!("create remote file failed: {e}"))?;
        file.close()
            .await
            .map_err(|e| format!("create remote file failed: {e}"))?;
        replace_remote_file(sftp, &part_path, remote_path).await?;
        let _ = std::fs::remove_file(&meta_path);
        return Ok(());
    }

    let flags = if offset > 0 {
        OpenFlags::CREATE | OpenFlags::WRITE
    } else {
        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
    };
    let mut remote = sftp.open_with_flags(&part_path, flags).await.map_err(|e| {
        log::error!("sftp: upload[{task_id}] open remote part failed {part_path}: {e}");
        e.to_string()
    })?;
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("open local failed: {e}"))?;
    if offset > 0 {
        remote
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("seek remote failed: {e}"))?;
        local
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("seek local failed: {e}"))?;
    }

    let mut buf = vec![0u8; 128 * 1024];
    let mut copied: u64 = offset;
    let mut last = Instant::now();
    let mut last_bytes: u64 = 0;
    let mut last_log = Instant::now();
    loop {
        if pause.load(Ordering::Relaxed) {
            let _ = tokio::time::timeout(Duration::from_secs(5), remote.shutdown()).await;
            let actual = sftp
                .metadata(&part_path)
                .await
                .map(|m| m.len())
                .unwrap_or(copied);
            let _ = write_meta(
                &meta_path,
                &TransferMeta {
                    version: META_VERSION,
                    direction: "upload".into(),
                    source_path: local_path.to_string(),
                    final_path: remote_path.to_string(),
                    part_path: part_path.clone(),
                    source_size: total,
                    source_mtime: local_mtime,
                    source_hash: source_hash.clone(),
                    transferred: actual,
                },
            );
            meter.transferred.store(actual, Ordering::Relaxed);
            log::info!("sftp: upload[{task_id}] paused at {actual} bytes, partial file kept");
            return Err("paused by user".into());
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = tokio::time::timeout(Duration::from_secs(5), remote.shutdown()).await;
            let _ = sftp.remove_file(&part_path).await;
            let _ = std::fs::remove_file(&meta_path);
            log::info!("sftp: upload[{task_id}] cancelled, removed partial remote file");
            return Err("cancelled by user".into());
        }
        let n = match local.read(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                let _ = tokio::time::timeout(Duration::from_secs(5), remote.shutdown()).await;
                let _ = write_meta(
                    &meta_path,
                    &TransferMeta {
                        version: META_VERSION,
                        direction: "upload".into(),
                        source_path: local_path.to_string(),
                        final_path: remote_path.to_string(),
                        part_path: part_path.clone(),
                        source_size: total,
                        source_mtime: local_mtime,
                        source_hash: source_hash.clone(),
                        transferred: copied,
                    },
                );
                log::error!("sftp: upload[{task_id}] read local failed: {e}");
                return Err(format!("read local failed: {e}"));
            }
        };
        if n == 0 {
            break;
        }
        if let Err(e) = remote.write_all(&buf[..n]).await {
            let _ = tokio::time::timeout(Duration::from_secs(5), remote.shutdown()).await;
            let _ = write_meta(
                &meta_path,
                &TransferMeta {
                    version: META_VERSION,
                    direction: "upload".into(),
                    source_path: local_path.to_string(),
                    final_path: remote_path.to_string(),
                    part_path: part_path.clone(),
                    source_size: total,
                    source_mtime: local_mtime,
                    source_hash: source_hash.clone(),
                    transferred: copied,
                },
            );
            log::error!("sftp: upload[{task_id}] write remote failed at {copied}: {e}");
            return Err(format!("write remote failed: {e}"));
        }
        copied += n as u64;
        meter.transferred.store(copied, Ordering::Relaxed);
        let now = Instant::now();
        let dt = now.duration_since(last);
        if dt.as_millis() >= 200 {
            let speed = (copied - last_bytes) as f64 / dt.as_secs_f64().max(0.001);
            let progress = if total > 0 {
                (copied as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            let _ = app.emit(
                "transfer-progress",
                serde_json::json!({
                    "taskId": task_id, "progress": progress, "speed": speed,
                    "status": "running", "transferredBytes": copied, "totalBytes": total,
                }),
            );
            if now.duration_since(last_log).as_secs() >= 2 {
                log::debug!(
                    "sftp: upload[{task_id}] progress {progress:.1}% copied={copied} speed={speed:.0} B/s"
                );
                last_log = now;
            }
            last = now;
            last_bytes = copied;
        }
    }
    remote
        .shutdown()
        .await
        .map_err(|e| format!("shutdown remote failed: {e}"))?;
    let actual = sftp
        .metadata(&part_path)
        .await
        .map(|m| m.len())
        .unwrap_or(copied);
    if actual != total {
        log::error!("sftp: upload[{task_id}] incomplete {actual}/{total} bytes");
        return Err(format!("upload incomplete: {actual}/{total} bytes"));
    }
    meter.transferred.store(actual, Ordering::Relaxed);
    replace_remote_file(sftp, &part_path, remote_path).await?;
    let _ = std::fs::remove_file(&meta_path);
    log::info!(
        "sftp: upload[{task_id}] done copied={actual} bytes in {:.1}s",
        last.elapsed().as_secs_f64()
    );
    Ok(())
}

async fn transfer_download(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &str,
    task_id: &str,
    cancel: &AtomicBool,
    pause: &AtomicBool,
    app: &AppHandle,
    meter: &TransferMeter,
) -> Result<(), String> {
    let remote_meta = sftp.metadata(remote_path).await.map_err(|e| {
        log::error!("sftp: download[{task_id}] stat remote failed {remote_path}: {e}");
        format!("open remote failed: {e}")
    })?;
    let total = remote_meta.len();
    let remote_mtime = remote_meta.mtime.unwrap_or(0) as i64;
    meter.total.store(total, Ordering::Relaxed);
    let source_hash = remote_prefix_hash(sftp, remote_path, HASH_PREFIX_LEN)
        .await
        .map_err(|e| {
            log::error!("sftp: download[{task_id}] hash remote prefix failed: {e}");
            e
        })?;

    let part = download_part_path(local_path);
    let part_str = part.to_string_lossy().into_owned();
    let meta_path = download_meta_path(local_path);
    let mut offset = 0u64;
    let mut restart_notice = false;

    if let Some(meta) = load_meta(&meta_path) {
        if meta_matches_download(
            &meta,
            remote_path,
            local_path,
            &part_str,
            total,
            remote_mtime,
            &source_hash,
        ) {
            if let Ok(part_meta) = tokio::fs::metadata(&part).await {
                if part_meta.len() >= meta.transferred {
                    // 本地半成品首段必须与远端源文件一致，防止目录里同名残留被续接
                    let prefix_ok = if meta.transferred == 0 {
                        true
                    } else {
                        let check_len = check_hash_len(total, meta.transferred);
                        match (
                            local_prefix_hash(&part, check_len).await,
                            remote_prefix_hash(sftp, remote_path, check_len).await,
                        ) {
                            (Ok(local), Ok(remote)) => local == remote,
                            _ => false,
                        }
                    };
                    if prefix_ok {
                        offset = meta.transferred;
                        if part_meta.len() > offset {
                            match tokio::fs::OpenOptions::new().write(true).open(&part).await {
                                Ok(file) => {
                                    if let Err(e) = file.set_len(offset).await {
                                        log::warn!(
                                            "sftp: download[{task_id}] truncate part to {offset} failed: {e}"
                                        );
                                        offset = 0;
                                    }
                                }
                                Err(_) => offset = 0,
                            }
                        }
                    }
                }
            }
        }
        if offset == 0 {
            if meta.transferred > 0 {
                restart_notice = true;
                log::warn!(
                    "sftp: download[{task_id}] previous transfer cannot be verified, restart from zero"
                );
            }
            let _ = tokio::fs::remove_file(&part).await;
            let _ = std::fs::remove_file(&meta_path);
        }
    } else if part.exists() {
        // 没有校验元数据，无法确认半成品来源，删除后重新下载
        restart_notice = true;
        let _ = tokio::fs::remove_file(&part).await;
    }

    if offset > 0 {
        log::info!("sftp: download[{task_id}] verified resume from offset={offset} bytes");
    } else {
        log::info!("sftp: download[{task_id}] start total={total} bytes");
        if restart_notice {
            let _ = app.emit(
                "transfer-progress",
                serde_json::json!({
                    "taskId": task_id, "status": "running", "progress": 0.0,
                    "speed": 0.0, "transferredBytes": 0, "totalBytes": total,
                    "restarted": true,
                }),
            );
        }
    }

    write_meta(
        &meta_path,
        &TransferMeta {
            version: META_VERSION,
            direction: "download".into(),
            source_path: remote_path.to_string(),
            final_path: local_path.to_string(),
            part_path: part_str.clone(),
            source_size: total,
            source_mtime: remote_mtime,
            source_hash: source_hash.clone(),
            transferred: offset,
        },
    )?;
    let start_progress = if total > 0 {
        (offset as f64 / total as f64) * 100.0
    } else {
        0.0
    };
    let _ = app.emit(
        "transfer-progress",
        serde_json::json!({
            "taskId": task_id, "status": "running", "progress": start_progress,
            "speed": 0.0, "transferredBytes": offset, "totalBytes": total,
        }),
    );

    if total == 0 {
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&part)
            .await
            .map_err(|e| format!("create local file failed: {e}"))?;
        file.sync_all()
            .await
            .map_err(|e| format!("sync local file failed: {e}"))?;
        drop(file);
        replace_local_part(&part, local_path)?;
        let _ = std::fs::remove_file(&meta_path);
        return Ok(());
    }

    let mut remote = sftp.open(remote_path).await.map_err(|e| {
        log::error!("sftp: download[{task_id}] open remote failed {remote_path}: {e}");
        format!("open remote failed: {e}")
    })?;
    if offset > 0 {
        remote
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("seek remote failed: {e}"))?;
    }
    let mut local = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(&part)
        .await
        .map_err(|e| format!("open local part failed: {e}"))?;
    if offset > 0 {
        local
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("seek local failed: {e}"))?;
    }

    let mut buf = vec![0u8; 128 * 1024];
    let mut copied: u64 = offset;
    let mut last = Instant::now();
    let mut last_bytes: u64 = 0;
    let mut last_log = Instant::now();
    loop {
        if pause.load(Ordering::Relaxed) {
            let _ = local.flush().await;
            let actual = tokio::fs::metadata(&part)
                .await
                .map(|m| m.len())
                .unwrap_or(copied);
            let _ = write_meta(
                &meta_path,
                &TransferMeta {
                    version: META_VERSION,
                    direction: "download".into(),
                    source_path: remote_path.to_string(),
                    final_path: local_path.to_string(),
                    part_path: part_str.clone(),
                    source_size: total,
                    source_mtime: remote_mtime,
                    source_hash: source_hash.clone(),
                    transferred: actual,
                },
            );
            meter.transferred.store(actual, Ordering::Relaxed);
            log::info!("sftp: download[{task_id}] paused at {actual} bytes, partial file kept");
            return Err("paused by user".into());
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = tokio::fs::remove_file(&part).await;
            let _ = std::fs::remove_file(&meta_path);
            log::info!("sftp: download[{task_id}] cancelled, removed partial local file");
            return Err("cancelled by user".into());
        }
        let n = match remote.read(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                let _ = local.flush().await;
                let actual = tokio::fs::metadata(&part)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(copied);
                let _ = write_meta(
                    &meta_path,
                    &TransferMeta {
                        version: META_VERSION,
                        direction: "download".into(),
                        source_path: remote_path.to_string(),
                        final_path: local_path.to_string(),
                        part_path: part_str.clone(),
                        source_size: total,
                        source_mtime: remote_mtime,
                        source_hash: source_hash.clone(),
                        transferred: actual,
                    },
                );
                log::error!("sftp: download[{task_id}] read remote failed at {copied}: {e}");
                return Err(format!("read remote failed: {e}"));
            }
        };
        if n == 0 {
            break;
        }
        if let Err(e) = local.write_all(&buf[..n]).await {
            let actual = tokio::fs::metadata(&part)
                .await
                .map(|m| m.len())
                .unwrap_or(copied);
            let _ = write_meta(
                &meta_path,
                &TransferMeta {
                    version: META_VERSION,
                    direction: "download".into(),
                    source_path: remote_path.to_string(),
                    final_path: local_path.to_string(),
                    part_path: part_str.clone(),
                    source_size: total,
                    source_mtime: remote_mtime,
                    source_hash: source_hash.clone(),
                    transferred: actual,
                },
            );
            log::error!("sftp: download[{task_id}] write local failed: {e}");
            return Err(format!("write local failed: {e}"));
        }
        copied += n as u64;
        meter.transferred.store(copied, Ordering::Relaxed);
        let now = Instant::now();
        let dt = now.duration_since(last);
        if dt.as_millis() >= 200 {
            let speed = (copied - last_bytes) as f64 / dt.as_secs_f64().max(0.001);
            let progress = if total > 0 {
                (copied as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            let _ = app.emit(
                "transfer-progress",
                serde_json::json!({
                    "taskId": task_id, "progress": progress, "speed": speed,
                    "status": "running", "transferredBytes": copied, "totalBytes": total,
                }),
            );
            if now.duration_since(last_log).as_secs() >= 2 {
                log::debug!(
                    "sftp: download[{task_id}] progress {progress:.1}% copied={copied} speed={speed:.0} B/s"
                );
                last_log = now;
            }
            last = now;
            last_bytes = copied;
        }
    }
    local
        .flush()
        .await
        .map_err(|e| format!("flush local failed: {e}"))?;
    let actual = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(copied);
    if actual != total {
        log::error!("sftp: download[{task_id}] incomplete {actual}/{total} bytes");
        return Err(format!("download incomplete: {actual}/{total} bytes"));
    }
    meter.transferred.store(actual, Ordering::Relaxed);
    replace_local_part(&part, local_path)?;
    let _ = std::fs::remove_file(&meta_path);
    log::info!(
        "sftp: download[{task_id}] done copied={actual} bytes in {:.1}s",
        last.elapsed().as_secs_f64()
    );
    Ok(())
}

async fn set_task(
    tasks: &Arc<Mutex<HashMap<String, TransferTask>>>,
    id: &str,
    f: impl FnOnce(&mut TransferTask),
) {
    let mut map = tasks.lock().await;
    if let Some(t) = map.get_mut(id) {
        f(t);
    }
}

fn sort_items(items: &mut Vec<SftpItem>) {
    items.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// 解析 /etc/passwd：每行 `name:x:uid:gid:...`，构建 uid → 用户名映射。
fn parse_passwd_map(s: &str) -> std::collections::HashMap<u32, String> {
    let mut map = std::collections::HashMap::new();
    for line in s.lines() {
        let f: Vec<&str> = line.split(':').collect();
        if f.len() >= 3 {
            if let Ok(uid) = f[2].trim().parse::<u32>() {
                map.insert(uid, f[0].to_string());
            }
        }
    }
    map
}

/// 解析 /etc/group：每行 `name:x:gid:members`，构建 gid → 组名映射。
fn parse_group_map(s: &str) -> std::collections::HashMap<u32, String> {
    let mut map = std::collections::HashMap::new();
    for line in s.lines() {
        let f: Vec<&str> = line.split(':').collect();
        if f.len() >= 3 {
            if let Ok(gid) = f[2].trim().parse::<u32>() {
                map.insert(gid, f[0].to_string());
            }
        }
    }
    map
}

/// 本地文件系统辅助：列出目录与获取主目录。
pub fn local_list(path: &str) -> Result<Vec<SftpItem>, String> {
    let rd = std::fs::read_dir(path).map_err(|e| format!("read_dir failed: {e}"))?;
    let mut items = Vec::new();
    for entry in rd {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let mut path = PathBuf::from(path);
        path.push(&name);
        items.push(SftpItem {
            name: name.clone(),
            path: path.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            mtime,
            perms: None,
            uid: None,
            gid: None,
            user_name: None,
            group_name: None,
        });
    }
    sort_items(&mut items);
    Ok(items)
}

pub fn local_home() -> Result<String, String> {
    std::env::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "cannot determine home directory".to_string())
}

fn ensure_safe_local_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("local path must be absolute".into());
    }
    Ok(p)
}

pub fn local_mkdir(path: &str) -> Result<(), String> {
    let p = ensure_safe_local_path(path)?;
    std::fs::create_dir(&p).map_err(|e| format!("create_dir failed: {e}"))
}

pub fn local_ensure_dir(path: &str) -> Result<(), String> {
    let p = ensure_safe_local_path(path)?;
    std::fs::create_dir_all(&p).map_err(|e| format!("create_dir_all failed: {e}"))
}

pub fn local_rename(old_path: &str, new_path: &str) -> Result<(), String> {
    let from = ensure_safe_local_path(old_path)?;
    let to = ensure_safe_local_path(new_path)?;
    if !from.exists() {
        return Err("source path not found".into());
    }
    if to.exists() {
        return Err("target path already exists".into());
    }
    std::fs::rename(&from, &to).map_err(|e| format!("rename failed: {e}"))
}

pub fn local_delete(path: &str, is_dir: bool) -> Result<(), String> {
    let p = ensure_safe_local_path(path)?;
    if let Some(home) = std::env::home_dir() {
        if p == home || p == PathBuf::from("/") {
            return Err("refusing to delete protected path".into());
        }
    }
    if is_dir {
        let empty = std::fs::read_dir(&p)
            .map_err(|e| format!("read_dir failed: {e}"))?
            .next()
            .is_none();
        if !empty {
            return Err("directory is not empty".into());
        }
        std::fs::remove_dir(&p).map_err(|e| format!("remove_dir failed: {e}"))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("remove_file failed: {e}"))
    }
}

pub fn local_open_path(path: &str) -> Result<(), String> {
    let p = ensure_safe_local_path(path)?;
    if !p.exists() {
        return Err("path not found".into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("explorer failed: {e}"))?;
    }
    Ok(())
}

// ---- 目录递归传输 ----

fn join_remote(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// 单文件上传（无进度推送，供目录递归复用）。返回拷贝字节数。
async fn upload_file_bytes(
    sftp: &SftpSession,
    local_path: &str,
    remote_path: &str,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("open local {local_path}: {e}"))?;
    let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);
    // 断点续传：远端已有部分则续传，完整则跳过，比本地大则从头覆盖
    let remote_existing = sftp
        .metadata(remote_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let offset = if remote_existing == total {
        return Ok(total);
    } else if remote_existing < total {
        remote_existing
    } else {
        0
    };
    let flags = if offset > 0 {
        OpenFlags::CREATE | OpenFlags::WRITE
    } else {
        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
    };
    let mut remote = sftp
        .open_with_flags(remote_path, flags)
        .await
        .map_err(|e| format!("open remote {remote_path}: {e}"))?;
    if offset > 0 {
        remote
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
        local
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut buf = vec![0u8; 128 * 1024];
    let mut copied: u64 = offset;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = sftp.remove_file(remote_path).await;
            return Err("cancelled by user".into());
        }
        let n = local.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| e.to_string())?;
        copied += n as u64;
    }
    remote.shutdown().await.map_err(|e| e.to_string())?;
    Ok(copied)
}

/// 单文件下载（无进度推送，供目录递归复用）。
async fn download_file_bytes(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &str,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    let mut remote = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("open remote {remote_path}: {e}"))?;
    let total = remote.metadata().await.map(|m| m.len()).unwrap_or(0);
    // 断点续传：本地已有部分则续传，完整则跳过
    let mut local = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(local_path)
        .await
        .map_err(|e| format!("open local {local_path}: {e}"))?;
    let local_existing = local.metadata().await.map(|m| m.len()).unwrap_or(0);
    let offset = if local_existing >= total && total > 0 {
        return Ok(total);
    } else {
        local_existing
    };
    if offset > 0 {
        remote
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
        local
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut buf = vec![0u8; 128 * 1024];
    let mut copied: u64 = offset;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(local_path);
            return Err("cancelled by user".into());
        }
        let n = remote.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        local
            .write_all(&buf[..n])
            .await
            .map_err(|e| e.to_string())?;
        copied += n as u64;
    }
    local.flush().await.map_err(|e| e.to_string())?;
    remote.shutdown().await.map_err(|e| e.to_string())?;
    Ok(copied)
}

/// 递归上传目录：远程按需建目录，文件逐个上传；按文件数推送进度。
async fn transfer_upload_dir(
    sftp: &SftpSession,
    local_dir: &str,
    remote_dir: &str,
    task_id: &str,
    cancel: &AtomicBool,
    app: &AppHandle,
) -> Result<(), String> {
    // 先递归统计待上传文件总数
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_local_files(Path::new(local_dir), &mut files);
    let total = files.len().max(1) as f64;
    log::info!(
        "sftp: upload-dir[{task_id}] scanning {local_dir}: {} files to upload",
        files.len()
    );
    let _ = sftp.create_dir(remote_dir).await; // 目标已存在则忽略错误

    let mut done: u64 = 0;
    for f in files {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled by user".into());
        }
        // 相对路径（相对 local_dir），用于映射远程结构
        let rel = f
            .strip_prefix(local_dir)
            .unwrap_or(&f)
            .to_string_lossy()
            .into_owned()
            .replace('\\', "/");
        let remote_child = if rel.is_empty() {
            remote_dir.to_string()
        } else {
            join_remote(remote_dir, &rel)
        };
        // 父目录在远程可能尚不存在（子目录），确保创建
        if let Some(parent) = remote_child.rsplit_once('/') {
            let _ = sftp.create_dir(parent.0).await;
        }
        log::debug!("sftp: upload-dir[{task_id}] uploading {rel}");
        match upload_file_bytes(sftp, &f.to_string_lossy(), &remote_child, cancel).await {
            Ok(_) => {}
            Err(e) => {
                log::error!("sftp: upload-dir[{task_id}] file {rel} failed: {e}");
                return Err(format!("file {rel}: {e}"));
            }
        }
        done += 1;
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "taskId": task_id,
                "progress": (done as f64 / total) * 100.0,
                "speed": 0.0,
                "status": "running",
            }),
        );
    }
    Ok(())
}

/// 递归下载目录：本地建目录，文件逐个下载。
async fn transfer_download_dir(
    sftp: &SftpSession,
    remote_dir: &str,
    local_dir: &str,
    task_id: &str,
    cancel: &AtomicBool,
    app: &AppHandle,
) -> Result<(), String> {
    std::fs::create_dir_all(local_dir).map_err(|e| e.to_string())?;
    let entries = sftp
        .read_dir(remote_dir)
        .await
        .map_err(|e| format!("read_dir {remote_dir}: {e}"))?;
    let items: Vec<(String, String, bool)> = entries
        .map(|e| {
            let name = e.file_name();
            let meta = e.metadata();
            (name.clone(), join_remote(remote_dir, &name), meta.is_dir())
        })
        .collect();
    let total = items.len().max(1) as f64;
    log::info!(
        "sftp: download-dir[{task_id}] scanning {remote_dir}: {} entries",
        items.len()
    );
    let mut done: u64 = 0;
    for (name, remote_child, is_dir) in items {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled by user".into());
        }
        let local_child = std::path::Path::new(local_dir).join(&name);
        if is_dir {
            Box::pin(transfer_download_dir(
                sftp,
                &remote_child,
                &local_child.to_string_lossy(),
                task_id,
                cancel,
                app,
            ))
            .await?;
        } else {
            log::debug!("sftp: download-dir[{task_id}] downloading {name}");
            download_file_bytes(sftp, &remote_child, &local_child.to_string_lossy(), cancel)
                .await
                .map_err(|e| format!("file {name}: {e}"))?;
        }
        done += 1;
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "taskId": task_id,
                "progress": (done as f64 / total) * 100.0,
                "speed": 0.0,
                "status": "running",
            }),
        );
    }
    Ok(())
}

/// 递归收集本地目录下全部文件（不包含目录自身）。
fn collect_local_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                collect_local_files(&p, out);
            } else {
                out.push(p);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, is_dir: bool) -> SftpItem {
        SftpItem {
            name: name.to_string(),
            path: format!("/tmp/{name}"),
            is_dir,
            size: 0,
            mtime: 0,
            perms: None,
            uid: None,
            gid: None,
            user_name: None,
            group_name: None,
        }
    }

    fn transfer_task(id: &str, status: &str) -> TransferTask {
        TransferTask {
            id: id.to_string(),
            session_id: "s1".into(),
            connection_id: "c1".into(),
            file_name: "file.bin".into(),
            direction: "download".into(),
            local_path: "/tmp/file.bin".into(),
            remote_path: "/srv/file.bin".into(),
            status: status.into(),
            progress: 0.0,
            speed: 0.0,
            transferred_bytes: 0,
            total_bytes: 0,
            error: None,
            is_dir: false,
            created_at: 0,
        }
    }

    #[test]
    fn sort_items_dir_first_then_name() {
        let mut items = vec![
            item("b.txt", false),
            item("a_dir", true),
            item("A.txt", false),
            item("z_dir", true),
        ];
        sort_items(&mut items);
        // 目录在前，文件按名称（忽略大小写）排后
        assert_eq!(
            items
                .iter()
                .map(|i| (i.name.as_str(), i.is_dir))
                .collect::<Vec<_>>(),
            vec![
                ("a_dir", true),
                ("z_dir", true),
                ("A.txt", false),
                ("b.txt", false),
            ]
        );
    }

    #[test]
    fn sort_items_keep_empty() {
        let mut items: Vec<SftpItem> = vec![];
        sort_items(&mut items);
        assert!(items.is_empty());
    }

    #[test]
    fn join_remote_root_and_normal() {
        assert_eq!(join_remote("/", "a.txt"), "/a.txt");
        assert_eq!(join_remote("/home", "a.txt"), "/home/a.txt");
        assert_eq!(join_remote("/home/user/", "a.txt"), "/home/user//a.txt");
    }

    #[test]
    fn local_list_sorts_dirs_first() {
        let dir = std::env::temp_dir().join(format!("termix_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        std::fs::write(dir.join("B.log"), "world").unwrap();

        let items = local_list(&dir.to_string_lossy()).unwrap();
        let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
        // 目录在前，文件按名称忽略大小写
        assert_eq!(names, vec!["sub", "a.txt", "B.log"]);
        // 路径以目录为前缀
        assert!(items[0]
            .path
            .starts_with(&dir.to_string_lossy().to_string()));
        assert_eq!(items[1].size, 5);
        assert!(items[0].is_dir);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn local_list_missing_dir_returns_err() {
        let dir = std::env::temp_dir().join("termix_no_such_dir_xyz");
        assert!(local_list(&dir.to_string_lossy()).is_err());
    }

    #[test]
    fn parse_passwd_and_group_map() {
        let passwd = "root:x:0:0:root:/root:/bin/bash\n\
            daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin";
        let users = parse_passwd_map(passwd);
        assert_eq!(users.get(&0).map(String::as_str), Some("root"));
        assert_eq!(users.get(&1).map(String::as_str), Some("daemon"));
        assert!(users.get(&999).is_none());

        let group = "root:x:0:\n\
            staff:x:1000:alice,bob";
        let groups = parse_group_map(group);
        assert_eq!(groups.get(&0).map(String::as_str), Some("root"));
        assert_eq!(groups.get(&1000).map(String::as_str), Some("staff"));
        assert!(groups.get(&999).is_none());
    }

    #[test]
    fn parse_id_maps_ignore_malformed() {
        let users = parse_passwd_map("not-a-line\n:x:\nuser:x:abc:xyz");
        assert!(users.is_empty());
        let groups = parse_group_map("");
        assert!(groups.is_empty());
    }

    #[test]
    fn collect_local_files_recursive() {
        let dir = std::env::temp_dir().join(format!("termix_collect_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("a").join("b")).unwrap();
        std::fs::write(dir.join("f1.txt"), "").unwrap();
        std::fs::write(dir.join("a").join("f2.txt"), "").unwrap();
        std::fs::write(dir.join("a").join("b").join("f3.txt"), "").unwrap();

        let mut files = Vec::new();
        collect_local_files(&dir, &mut files);
        let mut names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["f1.txt", "f2.txt", "f3.txt"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn local_mkdir_and_rename_roundtrip() {
        let dir = std::env::temp_dir().join(format!("termix_mkdir_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old");
        let s = path.to_string_lossy().into_owned();
        local_mkdir(&s).unwrap();
        assert!(path.is_dir());

        let new_path = dir.join("new");
        local_rename(&s, &new_path.to_string_lossy()).unwrap();
        assert!(!path.exists() && new_path.is_dir());

        std::fs::remove_dir(&new_path).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn local_delete_rejects_nonempty_and_root() {
        let dir = std::env::temp_dir().join(format!("termix_delete_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let s = dir.to_string_lossy().into_owned();
        assert!(local_delete(&s, true).unwrap_err().contains("not empty"));
        std::fs::remove_dir(dir.join("sub")).unwrap();
        local_delete(&s, true).unwrap();
        assert!(!dir.exists());
        assert!(local_delete("/", true).is_err());
    }

    #[test]
    fn local_mkdir_rejects_relative_path() {
        assert!(local_mkdir("relative/path")
            .unwrap_err()
            .contains("absolute"));
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn stable_key_is_deterministic_and_path_sensitive() {
        let a = stable_key("session\0/Users/a.txt\0/opt/a.txt");
        let b = stable_key("session\0/Users/a.txt\0/opt/a.txt");
        let c = stable_key("session\0/Users/b.txt\0/opt/a.txt");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn check_hash_len_uses_only_persisted_bytes() {
        assert_eq!(check_hash_len(10_000, 4_000), 4_000);
        assert_eq!(check_hash_len(1_000_000, 4_000), 4_000);
        assert_eq!(check_hash_len(1_000_000, 500_000), HASH_PREFIX_LEN);
        assert_eq!(check_hash_len(0, 0), 0);
    }

    #[test]
    fn connection_loss_messages_are_classified() {
        assert!(looks_like_connection_loss("read remote failed: EOF"));
        assert!(looks_like_connection_loss(
            "write remote failed: broken pipe"
        ));
        assert!(looks_like_connection_loss("connection reset by peer"));
        assert!(!looks_like_connection_loss("permission denied"));
        assert!(!looks_like_connection_loss("no space left on device"));
    }

    #[test]
    fn part_and_meta_paths_are_derived_from_destination() {
        assert_eq!(
            download_part_path("/tmp/report.pdf"),
            PathBuf::from("/tmp/report.pdf.termix-part")
        );
        assert_eq!(
            download_meta_path("/tmp/report.pdf"),
            PathBuf::from("/tmp/report.pdf.termix-part.json")
        );
        assert_eq!(
            upload_part_path("/srv/report.pdf"),
            "/srv/report.pdf.termix-part"
        );
        assert_eq!(
            upload_meta_path("/tmp/a", "/srv/a", "s1")
                .extension()
                .and_then(|v| v.to_str()),
            Some("json")
        );
    }

    #[test]
    fn transfer_meta_roundtrip() {
        let dir = std::env::temp_dir().join(format!("termix_meta_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("task.json");
        let meta = TransferMeta {
            version: META_VERSION,
            direction: "download".into(),
            source_path: "/srv/data.bin".into(),
            final_path: "/tmp/data.bin".into(),
            part_path: "/tmp/data.bin.termix-part".into(),
            source_size: 4096,
            source_mtime: 1_700_000_000,
            source_hash: "abc".into(),
            transferred: 1024,
        };
        write_meta(&path, &meta).unwrap();
        let loaded = load_meta(&path).expect("metadata should load");
        assert_eq!(loaded.source_path, meta.source_path);
        assert_eq!(loaded.transferred, 1024);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn delete_and_clear_terminal_transfer_tasks() {
        let service = SftpService::new(Arc::new(SshManager::new()));
        service
            .tasks
            .lock()
            .await
            .insert("done".into(), transfer_task("done", "completed"));
        service
            .tasks
            .lock()
            .await
            .insert("failed".into(), transfer_task("failed", "failed"));

        service.transfer_delete("done").await.unwrap();
        let list = service.transfer_list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "failed");

        assert_eq!(service.transfer_clear().await.unwrap(), 1);
        assert!(service.transfer_list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_running_task_cancels_and_suppresses_late_event() {
        let service = SftpService::new(Arc::new(SshManager::new()));
        let cancel = Arc::new(AtomicBool::new(false));
        service
            .tasks
            .lock()
            .await
            .insert("running".into(), transfer_task("running", "running"));
        service
            .cancels
            .lock()
            .await
            .insert("running".into(), cancel.clone());

        service.transfer_delete("running").await.unwrap();

        assert!(cancel.load(Ordering::Relaxed));
        assert!(service.transfer_list().await.unwrap().is_empty());
        assert!(service.removed_tasks.lock().await.contains("running"));
    }
}
