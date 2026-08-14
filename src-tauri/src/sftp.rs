use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
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
    pub error: Option<String>,
    pub is_dir: bool,
}

/// 传输任务的取消/暂停标志（与全局注册表共享的 Arc 句柄）。
struct TransferFlags {
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
}

pub struct SftpService {
    ssh: Arc<SshManager>,
    sessions: Mutex<HashMap<String, Arc<SftpSession>>>,
    tasks: Arc<Mutex<HashMap<String, TransferTask>>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pauses: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl SftpService {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self {
            ssh,
            sessions: Mutex::new(HashMap::new()),
            tasks: Arc::new(Mutex::new(HashMap::new())),
            cancels: Arc::new(Mutex::new(HashMap::new())),
            pauses: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn session(&self, connection_id: &str) -> Result<Arc<SftpSession>, String> {
        if let Some(s) = self.sessions.lock().await.get(connection_id) {
            log::debug!("sftp: reuse cached session for connection {connection_id}");
            return Ok(s.clone());
        }
        let handle = self
            .ssh
            .get_handle(connection_id)
            .await
            .ok_or_else(|| {
                log::warn!("sftp: session requested for unknown connection {connection_id}");
                "connection not found".to_string()
            })?;
        log::info!("sftp: opening SFTP subsystem for connection {connection_id}");
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| {
                log::error!("sftp: open channel failed for {connection_id}: {e}");
                format!("open channel failed: {e}")
            })?;
        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            log::error!("sftp: request subsystem failed for {connection_id}: {e}");
            format!("request subsystem failed: {e}")
        })?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| {
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

    pub async fn list(&self, connection_id: &str, path: &str) -> Result<Vec<SftpItem>, String> {
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
            });
        }
        sort_items(&mut items);
        log::debug!("sftp: list conn={connection_id} path={path} -> {} entries", items.len());
        Ok(items)
    }

    pub async fn mkdir(&self, connection_id: &str, path: &str) -> Result<(), String> {
        let sftp = self.session(connection_id).await?;
        log::info!("sftp: mkdir conn={connection_id} path={path}");
        sftp.create_dir(path).await.map_err(|e| {
            log::error!("sftp: mkdir failed conn={connection_id} path={path}: {e}");
            e.to_string()
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
        sftp.rename(old_path, new_path)
            .await
            .map_err(|e| {
                log::error!("sftp: rename failed conn={connection_id} {old_path} -> {new_path}: {e}");
                e.to_string()
            })
    }

    pub async fn chmod(
        &self,
        connection_id: &str,
        path: &str,
        mode: u32,
    ) -> Result<(), String> {
        let sftp = self.session(connection_id).await?;
        let attrs = russh_sftp::protocol::FileAttributes {
            permissions: Some(mode),
            ..Default::default()
        };
        log::info!("sftp: chmod conn={connection_id} path={path} mode={mode:o}");
        sftp.set_metadata(path, attrs)
            .await
            .map_err(|e| {
                log::error!("sftp: chmod failed conn={connection_id} path={path}: {e}");
                e.to_string()
            })
    }

    /// 传输任务的取消/暂停标志（与全局注册表共享的 Arc 句柄）。
    async fn register_flags(&self, task_id: &str) -> TransferFlags {
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = Arc::new(AtomicBool::new(false));
        self.cancels.lock().await.insert(task_id.to_string(), cancel.clone());
        self.pauses.lock().await.insert(task_id.to_string(), pause.clone());
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
        F: FnOnce(Arc<SftpSession>, Arc<AtomicBool>, Arc<AtomicBool>, AppHandle) -> Fut
            + Send
            + 'static,
        Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,
    {
        let tid = task.id.clone();
        let fname = task.file_name.clone();
        let dir = task.direction.clone();
        task.status = "running".into();
        task.error = None;
        self.tasks.lock().await.insert(tid.clone(), task);

        let flags = self.register_flags(&tid).await;
        let tasks = self.tasks.clone();
        let cancels = self.cancels.clone();
        let pauses = self.pauses.clone();
        let emit_app = app.clone();
        let tid_inner = tid.clone();
        let cancel_inner = flags.cancel.clone();
        let pause_inner = flags.pause.clone();
        tokio::spawn(async move {
            let result = run(sftp, cancel_inner.clone(), pause_inner.clone(), app).await;
            match result {
                Ok(()) => {
                    log::info!("sftp: {dir} task {tid_inner} completed");
                    set_task(&tasks, &tid_inner, |t| {
                        t.status = "completed".into();
                        t.progress = 100.0;
                    })
                    .await;
                }
                Err(e) => {
                    let status = if pause_inner.load(Ordering::Relaxed) {
                        "paused"
                    } else if cancel_inner.load(Ordering::Relaxed) {
                        "cancelled"
                    } else {
                        "failed"
                    };
                    let msg = format!("{dir} {status}: {e}");
                    if status == "failed" {
                        log::error!("sftp: {dir} task {tid_inner} failed: {e}");
                    } else {
                        log::info!("sftp: {dir} task {tid_inner} {status}");
                    }
                    set_task(&tasks, &tid_inner, |t| {
                        t.status = status.into();
                        t.error = Some(msg.clone());
                    })
                    .await;
                    let _ = emit_app.emit(
                        "transfer-progress",
                        serde_json::json!({
                            "taskId": tid_inner, "fileName": fname, "direction": dir,
                            "progress": 0.0, "speed": 0.0, "status": status, "error": msg,
                        }),
                    );
                }
            }
            cancels.lock().await.remove(&tid_inner);
            pauses.lock().await.remove(&tid_inner);
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
            error: None,
            is_dir: false,
        };
        let local = local_path.to_string();
        let remote = remote_path.to_string();
        self.spawn_transfer(sftp, task, app, move |sftp, cancel, pause, app| async move {
            transfer_upload(&sftp, &local, &remote, &task_id, &cancel, &pause, &app).await
        })
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
            error: None,
            is_dir: false,
        };
        let local = local_path.to_string();
        let remote = remote_path.to_string();
        self.spawn_transfer(sftp, task, app, move |sftp, cancel, pause, app| async move {
            transfer_download(&sftp, &remote, &local, &task_id, &cancel, &pause, &app).await
        })
        .await
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
    pub async fn transfer_resume(
        &self,
        app: AppHandle,
        task_id: &str,
    ) -> Result<(), String> {
        let task = self
            .tasks
            .lock()
            .await
            .get(task_id)
            .cloned()
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != "paused" {
            log::warn!("sftp: resume task {task_id} not in paused state ({})", task.status);
            return Err("仅可恢复已暂停的任务".into());
        }
        // 复用原任务的连接与会话
        let sftp = self.session(&task.connection_id).await?;
        log::info!("sftp: resume task {task_id} ({})", task.direction);
        let direction = task.direction.clone();
        let local = task.local_path.clone();
        let remote = task.remote_path.clone();
        let tid = task_id.to_string();
        self.spawn_transfer(sftp, task, app, move |sftp, cancel, pause, app| async move {
            if direction == "upload" {
                transfer_upload(&sftp, &local, &remote, &tid, &cancel, &pause, &app).await
            } else {
                transfer_download(&sftp, &remote, &local, &tid, &cancel, &pause, &app).await
            }
        })
        .await?;
        Ok(())
    }

    pub async fn transfer_list(&self) -> Result<Vec<TransferTask>, String> {
        let tasks = self.tasks.lock().await;
        let mut list: Vec<TransferTask> = tasks.values().cloned().collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
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
            error: None,
            is_dir: true,
        };
        let local = local_dir.to_string();
        let remote = remote_dir.to_string();
        self.spawn_transfer(sftp, task, app, move |sftp, cancel, _pause, app| async move {
            transfer_upload_dir(&sftp, &local, &remote, &task_id, &cancel, &app).await
        })
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
            error: None,
            is_dir: true,
        };
        let local = local_dir.to_string();
        let remote = remote_dir.to_string();
        self.spawn_transfer(sftp, task, app, move |sftp, cancel, _pause, app| async move {
            transfer_download_dir(&sftp, &remote, &local, &task_id, &cancel, &app).await
        })
        .await
    }

    /// 会话断开时释放 SFTP 会话缓存。
    pub async fn drop_session(&self, connection_id: &str) {
        if let Some(s) = self.sessions.lock().await.remove(connection_id) {
            log::info!("sftp: closing SFTP session for connection {connection_id}");
            let _ = s.close().await;
        } else {
            log::debug!("sftp: no cached session to drop for {connection_id}");
        }
    }

    pub async fn transfer_cancel(&self, task_id: &str) -> Result<(), String> {
        let cancels = self.cancels.lock().await;
        if let Some(f) = cancels.get(task_id) {
            log::info!("sftp: cancel transfer task {task_id}");
            f.store(true, Ordering::Relaxed);
            Ok(())
        } else {
            log::warn!("sftp: cancel task {task_id} not found or already finished");
            Err("task not found or already finished".into())
        }
    }
}

async fn transfer_upload(
    sftp: &SftpSession,
    local_path: &str,
    remote_path: &str,
    task_id: &str,
    cancel: &AtomicBool,
    pause: &AtomicBool,
    app: &AppHandle,
) -> Result<(), String> {
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| {
            log::error!("sftp: upload[{task_id}] open local failed {local_path}: {e}");
            e.to_string()
        })?;
    let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);
    // 断点续传：远端已有部分则从该偏移继续，远端更完整则跳过，远端比本地大则从头覆盖
    let remote_existing = sftp
        .metadata(remote_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let offset = if remote_existing == total {
        log::info!(
            "sftp: upload[{task_id}] remote already complete ({total} bytes), skip transfer"
        );
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "taskId": task_id, "progress": 100.0, "speed": 0.0, "status": "completed"
            }),
        );
        return Ok(());
    } else if remote_existing < total {
        // 远端存在部分内容，从该偏移续传
        remote_existing
    } else {
        // 远端比本地还大（内容冲突），从头覆盖
        log::info!(
            "sftp: upload[{task_id}] remote({remote_existing}) larger than local({total}), restart from scratch"
        );
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
        .map_err(|e| {
            log::error!("sftp: upload[{task_id}] open remote failed {remote_path}: {e}");
            e.to_string()
        })?;
    if offset > 0 {
        remote
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| {
                log::error!("sftp: upload[{task_id}] seek remote to {offset} failed: {e}");
                e.to_string()
            })?;
        local
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| {
                log::error!("sftp: upload[{task_id}] seek local to {offset} failed: {e}");
                e.to_string()
            })?;
        log::info!("sftp: upload[{task_id}] resume from offset={offset} bytes");
    } else {
        log::info!("sftp: upload[{task_id}] start total={total} bytes");
    }
    let mut buf = vec![0u8; 128 * 1024];
    let mut copied: u64 = offset;
    let mut last = Instant::now();
    let mut last_bytes: u64 = 0;
    let mut last_log = Instant::now();
    loop {
        if pause.load(Ordering::Relaxed) {
            log::info!("sftp: upload[{task_id}] paused at {copied} bytes, partial file kept");
            return Err("paused by user".into());
        }
        if cancel.load(Ordering::Relaxed) {
            log::info!("sftp: upload[{task_id}] cancelled, removing partial remote file");
            let _ = sftp.remove_file(remote_path).await;
            return Err("cancelled by user".into());
        }
        let n = local.read(&mut buf).await.map_err(|e| {
            log::error!("sftp: upload[{task_id}] read local failed: {e}");
            format!("read local failed: {e}")
        })?;
        if n == 0 {
            break;
        }
        remote.write_all(&buf[..n]).await.map_err(|e| {
            log::error!("sftp: upload[{task_id}] write remote failed at {copied}: {e}");
            format!("write remote failed: {e}")
        })?;
        copied += n as u64;
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
                serde_json::json!({ "taskId": task_id, "progress": progress, "speed": speed }),
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
    remote.shutdown().await.map_err(|e| {
        log::error!("sftp: upload[{task_id}] shutdown remote failed: {e}");
        e.to_string()
    })?;
    log::info!(
        "sftp: upload[{task_id}] done copied={copied} bytes in {:.1}s",
        last.elapsed().as_secs_f64()
    );
    let _ = app.emit(
        "transfer-progress",
        serde_json::json!({
            "taskId": task_id, "progress": 100.0, "speed": 0.0, "status": "completed"
        }),
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
) -> Result<(), String> {
    let mut remote = sftp.open(remote_path).await.map_err(|e| {
        log::error!("sftp: download[{task_id}] open remote failed {remote_path}: {e}");
        format!("open remote failed: {e}")
    })?;
    let total = remote.metadata().await.map(|m| m.len()).unwrap_or(0);
    // 断点续传：本地已有部分则从该偏移继续，本地更完整则跳过
    let mut local = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(local_path)
        .await
        .map_err(|e| {
            log::error!("sftp: download[{task_id}] open local failed {local_path}: {e}");
            e.to_string()
        })?;
    let local_existing = local.metadata().await.map(|m| m.len()).unwrap_or(0);
    let offset = if local_existing >= total && total > 0 {
        log::info!(
            "sftp: download[{task_id}] local already complete ({total} bytes), skip transfer"
        );
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "taskId": task_id, "progress": 100.0, "speed": 0.0, "status": "completed"
            }),
        );
        return Ok(());
    } else {
        local_existing
    };
    if offset > 0 {
        remote
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| {
                log::error!("sftp: download[{task_id}] seek remote to {offset} failed: {e}");
                e.to_string()
            })?;
        local
            .seek(tokio::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| {
                log::error!("sftp: download[{task_id}] seek local to {offset} failed: {e}");
                e.to_string()
            })?;
        log::info!("sftp: download[{task_id}] resume from offset={offset} bytes");
    } else {
        log::info!("sftp: download[{task_id}] start total={total} bytes");
    }
    let mut buf = vec![0u8; 128 * 1024];
    let mut copied: u64 = offset;
    let mut last = Instant::now();
    let mut last_bytes: u64 = 0;
    let mut last_log = Instant::now();
    loop {
        if pause.load(Ordering::Relaxed) {
            log::info!("sftp: download[{task_id}] paused at {copied} bytes, partial file kept");
            return Err("paused by user".into());
        }
        if cancel.load(Ordering::Relaxed) {
            log::info!("sftp: download[{task_id}] cancelled, removing partial local file");
            let _ = std::fs::remove_file(local_path);
            return Err("cancelled by user".into());
        }
        let n = remote.read(&mut buf).await.map_err(|e| {
            log::error!("sftp: download[{task_id}] read remote failed at {copied}: {e}");
            format!("read remote failed: {e}")
        })?;
        if n == 0 {
            break;
        }
        local.write_all(&buf[..n]).await.map_err(|e| {
            log::error!("sftp: download[{task_id}] write local failed: {e}");
            format!("write local failed: {e}")
        })?;
        copied += n as u64;
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
                serde_json::json!({ "taskId": task_id, "progress": progress, "speed": speed }),
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
    local.flush().await.map_err(|e| {
        log::error!("sftp: download[{task_id}] flush local failed: {e}");
        e.to_string()
    })?;
    remote.shutdown().await.map_err(|e| {
        log::error!("sftp: download[{task_id}] shutdown remote failed: {e}");
        e.to_string()
    })?;
    log::info!(
        "sftp: download[{task_id}] done copied={copied} bytes in {:.1}s",
        last.elapsed().as_secs_f64()
    );
    let _ = app.emit(
        "transfer-progress",
        serde_json::json!({
            "taskId": task_id, "progress": 100.0, "speed": 0.0, "status": "completed"
        }),
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
        remote.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
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
        local.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
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
            items.iter().map(|i| (i.name.as_str(), i.is_dir)).collect::<Vec<_>>(),
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
        assert!(items[0].path.starts_with(&dir.to_string_lossy().to_string()));
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
}
