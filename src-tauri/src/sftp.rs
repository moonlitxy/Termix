use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
    pub file_name: String,
    pub direction: String,
    pub local_path: String,
    pub remote_path: String,
    pub status: String,
    pub progress: f64,
    pub speed: f64,
    pub error: Option<String>,
}

pub struct SftpService {
    ssh: Arc<SshManager>,
    sessions: Mutex<HashMap<String, Arc<SftpSession>>>,
    tasks: Arc<Mutex<HashMap<String, TransferTask>>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl SftpService {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self {
            ssh,
            sessions: Mutex::new(HashMap::new()),
            tasks: Arc::new(Mutex::new(HashMap::new())),
            cancels: Arc::new(Mutex::new(HashMap::new())),
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
            file_name: file_name.clone(),
            direction: "upload".into(),
            local_path: local_path.to_string(),
            remote_path: remote_path.to_string(),
            status: "running".into(),
            progress: 0.0,
            speed: 0.0,
            error: None,
        };
        self.tasks.lock().await.insert(task_id.clone(), task);

        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels.lock().await.insert(task_id.clone(), cancel.clone());

        let tasks = self.tasks.clone();
        let cancels = self.cancels.clone();
        let app2 = app.clone();
        let local = local_path.to_string();
        let remote = remote_path.to_string();
        let tid = task_id.clone();
        let fname = file_name.clone();
        tokio::spawn(async move {
            match transfer_upload(&sftp, &local, &remote, &tid, &cancel, &app2).await {
                Ok(()) => {
                    log::info!("sftp: upload task {tid} completed");
                    set_task(&tasks, &tid, |t| {
                        t.status = "completed".into();
                        t.progress = 100.0;
                    })
                    .await;
                }
                Err(e) => {
                    let status = if cancel.load(Ordering::Relaxed) { "cancelled" } else { "failed" };
                    let msg = format!("upload {status}: {e}");
                    if status == "failed" {
                        log::error!("sftp: upload task {tid} failed: {e}");
                    } else {
                        log::info!("sftp: upload task {tid} cancelled");
                    }
                    set_task(&tasks, &tid, |t| {
                        t.status = status.into();
                        t.error = Some(msg.clone());
                    })
                    .await;
                    let _ = app2.emit(
                        "transfer-progress",
                        serde_json::json!({
                            "taskId": tid, "fileName": fname, "direction": "upload",
                            "progress": 0.0, "speed": 0.0, "status": status, "error": msg,
                        }),
                    );
                }
            }
            cancels.lock().await.remove(&tid);
        });
        Ok(task_id)
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
            file_name: file_name.clone(),
            direction: "download".into(),
            local_path: local_path.to_string(),
            remote_path: remote_path.to_string(),
            status: "running".into(),
            progress: 0.0,
            speed: 0.0,
            error: None,
        };
        self.tasks.lock().await.insert(task_id.clone(), task);

        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels.lock().await.insert(task_id.clone(), cancel.clone());

        let tasks = self.tasks.clone();
        let cancels = self.cancels.clone();
        let app2 = app.clone();
        let local = local_path.to_string();
        let remote = remote_path.to_string();
        let tid = task_id.clone();
        let fname = file_name.clone();
        tokio::spawn(async move {
            match transfer_download(&sftp, &remote, &local, &tid, &cancel, &app2).await {
                Ok(()) => {
                    log::info!("sftp: download task {tid} completed");
                    set_task(&tasks, &tid, |t| {
                        t.status = "completed".into();
                        t.progress = 100.0;
                    })
                    .await;
                }
                Err(e) => {
                    let status = if cancel.load(Ordering::Relaxed) { "cancelled" } else { "failed" };
                    let msg = format!("download {status}: {e}");
                    if status == "failed" {
                        log::error!("sftp: download task {tid} failed: {e}");
                    } else {
                        log::info!("sftp: download task {tid} cancelled");
                    }
                    set_task(&tasks, &tid, |t| {
                        t.status = status.into();
                        t.error = Some(msg.clone());
                    })
                    .await;
                    let _ = app2.emit(
                        "transfer-progress",
                        serde_json::json!({
                            "taskId": tid, "fileName": fname, "direction": "download",
                            "progress": 0.0, "speed": 0.0, "status": status, "error": msg,
                        }),
                    );
                }
            }
            cancels.lock().await.remove(&tid);
        });
        Ok(task_id)
    }

    pub async fn transfer_list(&self) -> Result<Vec<TransferTask>, String> {
        let tasks = self.tasks.lock().await;
        let mut list: Vec<TransferTask> = tasks.values().cloned().collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        log::debug!("sftp: transfer_list -> {} tasks", list.len());
        Ok(list)
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
    app: &AppHandle,
) -> Result<(), String> {
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| {
            log::error!("sftp: upload[{task_id}] open local failed {local_path}: {e}");
            e.to_string()
        })?;
    let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut remote = sftp
        .open_with_flags(
            remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| {
            log::error!("sftp: upload[{task_id}] open remote failed {remote_path}: {e}");
            e.to_string()
        })?;
    log::info!("sftp: upload[{task_id}] start total={total} bytes");
    let mut buf = vec![0u8; 128 * 1024];
    let mut copied: u64 = 0;
    let mut last = Instant::now();
    let mut last_bytes: u64 = 0;
    let mut last_log = Instant::now();
    loop {
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
    app: &AppHandle,
) -> Result<(), String> {
    let mut remote = sftp.open(remote_path).await.map_err(|e| {
        log::error!("sftp: download[{task_id}] open remote failed {remote_path}: {e}");
        format!("open remote failed: {e}")
    })?;
    let total = remote.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut local = tokio::fs::File::create(local_path).await.map_err(|e| {
        log::error!("sftp: download[{task_id}] create local failed {local_path}: {e}");
        e.to_string()
    })?;
    log::info!("sftp: download[{task_id}] start total={total} bytes");
    let mut buf = vec![0u8; 128 * 1024];
    let mut copied: u64 = 0;
    let mut last = Instant::now();
    let mut last_bytes: u64 = 0;
    let mut last_log = Instant::now();
    loop {
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
