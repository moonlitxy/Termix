use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::db::Db;
use crate::forward::ForwardService;
use crate::models::{
    CommandHistory, ForwardRule, ForwardRuleInput, Group, GroupInput, Metrics, ProcInfo, Session,
    SessionInput, Snippet, SnippetInput,
};
use crate::sftp::{SftpItem, SftpService, TransferTask};
use crate::ssh::SshManager;

pub struct AppState {
    pub db: Db,
    pub ssh: Arc<SshManager>,
    pub sftp: SftpService,
    pub forward: ForwardService,
}

impl AppState {
    pub fn new(db: Db) -> Self {
        let ssh = Arc::new(SshManager::new());
        let sftp = SftpService::new(ssh.clone());
        let forward = ForwardService::new(ssh.clone());
        Self {
            db,
            ssh,
            sftp,
            forward,
        }
    }
}

#[tauri::command]
pub async fn session_list(state: State<'_, AppState>) -> Result<Vec<Session>, String> {
    state.db.list_sessions()
}

#[tauri::command]
pub async fn session_create(
    input: SessionInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.db.create_session(input)
}

#[tauri::command]
pub async fn session_update(
    id: String,
    input: SessionInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.update_session(&id, input)
}

#[tauri::command]
pub async fn session_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db.delete_session(&id)
}

#[tauri::command]
pub async fn group_list(state: State<'_, AppState>) -> Result<Vec<Group>, String> {
    state.db.list_groups()
}

#[tauri::command]
pub async fn group_create(
    input: GroupInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.db.create_group(input)
}

#[tauri::command]
pub async fn group_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db.delete_group(&id)
}

#[tauri::command]
pub async fn session_connect(
    id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session = state
        .db
        .list_sessions()?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "session not found".to_string())?;
    let connection_id = state.ssh.connect(session).await?;
    state.db.touch_session(&id)?;
    Ok(connection_id)
}

#[tauri::command]
pub async fn session_disconnect(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.forward.stop_all().await;
    state.sftp.drop_session(&connection_id).await;
    state.ssh.disconnect(&connection_id).await
}

#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    connection_id: String,
    tab_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state
        .ssh
        .terminal_create(app, &connection_id, tab_id, cols, rows)
        .await
}

#[tauri::command]
pub async fn terminal_write(
    connection_id: String,
    shell_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .ssh
        .terminal_write(&connection_id, &shell_id, data.into_bytes())
        .await
}

#[tauri::command]
pub async fn terminal_resize(
    connection_id: String,
    shell_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .ssh
        .terminal_resize(&connection_id, &shell_id, cols, rows)
        .await
}

#[tauri::command]
pub async fn terminal_destroy(
    connection_id: String,
    shell_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.terminal_destroy(&connection_id, &shell_id).await
}

#[tauri::command]
pub async fn history_list(
    session_id: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<CommandHistory>, String> {
    state.db.list_history(&session_id, limit.unwrap_or(50))
}

#[tauri::command]
pub async fn history_add(
    session_id: String,
    command: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.db.add_history(&session_id, &command)
}

#[tauri::command]
pub async fn history_clear(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.clear_history(&session_id)
}

// ---- SFTP ----

#[tauri::command]
pub async fn sftp_list(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<SftpItem>, String> {
    state.sftp.list(&connection_id, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.sftp.mkdir(&connection_id, &path).await
}

#[tauri::command]
pub async fn sftp_remove(
    connection_id: String,
    path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.sftp.remove(&connection_id, &path, is_dir).await
}

#[tauri::command]
pub async fn sftp_rename(
    connection_id: String,
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .sftp
        .rename(&connection_id, &old_path, &new_path)
        .await
}

#[tauri::command]
pub async fn sftp_chmod(
    connection_id: String,
    path: String,
    mode: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.sftp.chmod(&connection_id, &path, mode).await
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    connection_id: String,
    session_id: String,
    local_path: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state
        .sftp
        .upload(app, &connection_id, &session_id, &local_path, &remote_path)
        .await
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    connection_id: String,
    session_id: String,
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state
        .sftp
        .download(app, &connection_id, &session_id, &remote_path, &local_path)
        .await
}

#[tauri::command]
pub async fn transfer_list(state: State<'_, AppState>) -> Result<Vec<TransferTask>, String> {
    state.sftp.transfer_list().await
}

#[tauri::command]
pub async fn transfer_cancel(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.sftp.transfer_cancel(&task_id).await
}

// ---- 本地文件系统（SFTP 双栏本地侧） ----

#[tauri::command]
pub fn local_list(path: String) -> Result<Vec<SftpItem>, String> {
    crate::sftp::local_list(&path)
}

#[tauri::command]
pub fn local_home() -> Result<String, String> {
    crate::sftp::local_home()
}

// ---- v0.3: 命令片段 ----

#[tauri::command]
pub async fn snippet_list(state: State<'_, AppState>) -> Result<Vec<Snippet>, String> {
    state.db.list_snippets()
}

#[tauri::command]
pub async fn snippet_create(
    input: SnippetInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.db.create_snippet(input)
}

#[tauri::command]
pub async fn snippet_update(
    id: String,
    input: SnippetInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.update_snippet(&id, input)
}

#[tauri::command]
pub async fn snippet_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db.delete_snippet(&id)
}

// ---- v0.3: 端口转发 ----

#[tauri::command]
pub async fn forward_list(state: State<'_, AppState>) -> Result<Vec<ForwardRule>, String> {
    state.db.list_forwards()
}

#[tauri::command]
pub async fn forward_create(
    input: ForwardRuleInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.db.create_forward(input)
}

#[tauri::command]
pub async fn forward_update(
    id: String,
    input: ForwardRuleInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.update_forward(&id, input)
}

#[tauri::command]
pub async fn forward_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.forward.stop(&id).await?;
    state.db.delete_forward(&id)
}

#[tauri::command]
pub async fn forward_start(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let rule = state
        .db
        .list_forwards()?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "rule not found".to_string())?;
    state.forward.start(&rule).await?;
    state.db.set_forward_enabled(&id, true)?;
    Ok(())
}

#[tauri::command]
pub async fn forward_stop(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.forward.stop(&id).await?;
    state.db.set_forward_enabled(&id, false)?;
    Ok(())
}

// ---- v0.3: 系统监控 ----

#[tauri::command]
pub async fn monitor_metrics(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Metrics, String> {
    let out = state
        .ssh
        .exec_command(
            &connection_id,
            "top -bn1 | sed -n '3p'; echo ---; free -b | sed -n '2p'; echo ---; df -k / | tail -n 1; echo ---; awk 'NR>2 {rx+=$2;tx+=$10} END {print rx, tx}' /proc/net/dev",
        )
        .await?;
    let parts: Vec<&str> = out.split("---").collect();
    let cpu = parts.first().and_then(|s| parse_first_f64(s)).unwrap_or(0.0);
    let (mem_used, mem_total) = parse_mem(parts.get(1).unwrap_or(&""));
    let disk_used_pct = parts
        .get(2)
        .and_then(|s| parse_disk_pct(s))
        .unwrap_or(0.0);
    let (net_rx, net_tx) = parse_net(parts.get(3).unwrap_or(&""));
    Ok(Metrics {
        cpu,
        mem_used,
        mem_total,
        disk_used_pct,
        net_rx,
        net_tx,
    })
}

#[tauri::command]
pub async fn monitor_processes(
    connection_id: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<ProcInfo>, String> {
    let n = limit.unwrap_or(20);
    let out = state
        .ssh
        .exec_command(
            &connection_id,
            &format!("ps aux --sort=-%cpu | head -n {}", n + 1),
        )
        .await?;
    let mut procs = Vec::new();
    for line in out.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 11 {
            continue;
        }
        procs.push(ProcInfo {
            pid: f[1].parse().unwrap_or(0),
            user: f[0].to_string(),
            cpu: f[2].parse().unwrap_or(0.0),
            mem: f[3].parse().unwrap_or(0.0),
            cmd: f[10..].join(" "),
        });
    }
    Ok(procs)
}

fn parse_first_f64(s: &str) -> Option<f64> {
    s.split(|c: char| !c.is_ascii_digit() && c != '.')
        .find(|t| !t.is_empty())
        .and_then(|t| t.parse().ok())
}

fn parse_mem(s: &str) -> (u64, u64) {
    let f: Vec<&str> = s.split_whitespace().collect();
    if f.len() >= 3 && f.first().copied() == Some("Mem:") {
        (
            f[2].parse().unwrap_or(0),
            f[1].parse().unwrap_or(0),
        )
    } else {
        (0, 0)
    }
}

fn parse_disk_pct(s: &str) -> Option<f64> {
    let f: Vec<&str> = s.split_whitespace().collect();
    if f.len() >= 5 {
        f[4].trim_end_matches('%').parse().ok()
    } else {
        None
    }
}

fn parse_net(s: &str) -> (u64, u64) {
    let f: Vec<&str> = s.split_whitespace().collect();
    if f.len() >= 2 {
        (
            f[0].parse().unwrap_or(0),
            f[1].parse().unwrap_or(0),
        )
    } else {
        (0, 0)
    }
}
