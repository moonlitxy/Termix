use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::crypto;
use crate::db::Db;
use crate::forward::ForwardService;
use crate::models::{
    CommandHistory, DiskInfo, ForwardRule, ForwardRuleInput, Group, GroupInput, MasterStatus,
    Metrics, ProcInfo, Session, SessionExport, SessionImportResult, SessionInput, Snippet,
    SnippetInput,
};
use crate::sftp::{SftpItem, SftpService, TransferTask};
use crate::ssh::SshManager;

/// 主密码解锁状态（密钥仅在内存中，不落盘）。
pub struct MasterService {
    key: std::sync::Mutex<Option<crypto::MasterKey>>,
}

impl MasterService {
    pub fn new() -> Self {
        Self {
            key: std::sync::Mutex::new(None),
        }
    }
    pub fn set_key(&self, k: crypto::MasterKey) {
        *self.key.lock().unwrap() = Some(k);
    }
    pub fn clear_key(&self) {
        *self.key.lock().unwrap() = None;
    }
    pub fn key(&self) -> Option<crypto::MasterKey> {
        *self.key.lock().unwrap()
    }
}

pub struct AppState {
    pub db: Db,
    pub ssh: Arc<SshManager>,
    pub sftp: SftpService,
    pub forward: ForwardService,
    pub master: MasterService,
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
            master: MasterService::new(),
        }
    }
}

fn session_to_input(s: &Session) -> SessionInput {
    SessionInput {
        name: s.name.clone(),
        host: s.host.clone(),
        port: s.port,
        username: s.username.clone(),
        auth_type: s.auth_type.clone(),
        password: s.password.clone(),
        private_key_path: s.private_key_path.clone(),
        private_key_passphrase: s.private_key_passphrase.clone(),
        group_id: s.group_id.clone(),
        memo: s.memo.clone(),
        encoding: Some(s.encoding.clone()),
    }
}

/// 使用主密钥加密会话的密码字段（已加密的跳过）。
fn encrypt_session_fields(input: &mut SessionInput, key: &crypto::MasterKey) {
    if let Some(p) = &input.password {
        if !crypto::is_encrypted(p) {
            input.password = Some(crypto::encrypt(key, p));
        }
    }
    if let Some(p) = &input.private_key_passphrase {
        if !crypto::is_encrypted(p) {
            input.private_key_passphrase = Some(crypto::encrypt(key, p));
        }
    }
}

fn encrypt_all_sessions(db: &Db, key: &crypto::MasterKey) -> Result<(), String> {
    for s in db.list_sessions()? {
        let mut input = session_to_input(&s);
        encrypt_session_fields(&mut input, key);
        db.update_session(&s.id, input)?;
    }
    Ok(())
}

fn decrypt_all_sessions(db: &Db, key: &crypto::MasterKey) -> Result<(), String> {
    for s in db.list_sessions()? {
        let mut input = session_to_input(&s);
        if let Some(p) = &input.password {
            if crypto::is_encrypted(p) {
                input.password = Some(crypto::decrypt(key, p)?);
            }
        }
        if let Some(p) = &input.private_key_passphrase {
            if crypto::is_encrypted(p) {
                input.private_key_passphrase = Some(crypto::decrypt(key, p)?);
            }
        }
        db.update_session(&s.id, input)?;
    }
    Ok(())
}

// ---- 主密码（安全设置） ----

#[tauri::command]
pub fn master_status(state: State<'_, AppState>) -> Result<MasterStatus, String> {
    Ok(MasterStatus {
        has_master: state.db.get_setting("master_salt").is_some(),
        unlocked: state.master.key().is_some(),
    })
}

/// 设置或修改主密码，并立即加密全部会话密码字段。
#[tauri::command]
pub fn master_set(
    master: String,
    old_master: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if master.len() < 4 {
        return Err("主密码至少 4 位".into());
    }
    // 已设置过：验证旧密码并先解密现有数据
    if let Some(hex) = state.db.get_setting("master_salt") {
        let old = old_master.ok_or_else(|| "请提供当前主密码".to_string())?;
        let salt = crypto::from_hex(&hex).map_err(|e| e.to_string())?;
        let old_key = crypto::derive_key(&old, &salt);
        let verify = state.db.get_setting("master_verify").unwrap_or_default();
        if !crypto::verify_master(&old_key, &verify) {
            return Err("当前主密码错误".into());
        }
        decrypt_all_sessions(&state.db, &old_key)?;
    }
    // 新盐 + 新密钥 + 重新加密
    let salt = crypto::gen_salt();
    let key = crypto::derive_key(&master, &salt);
    encrypt_all_sessions(&state.db, &key)?;
    state.db.set_setting("master_salt", &crypto::to_hex(&salt))?;
    state.db.set_setting("master_verify", &crypto::make_verify(&key))?;
    state.master.set_key(key);
    log::info!("master: password set/changed");
    Ok(())
}

/// 解锁：校验主密码后将派生密钥保存在内存中。
#[tauri::command]
pub fn master_unlock(master: String, state: State<'_, AppState>) -> Result<(), String> {
    let salt_hex = state
        .db
        .get_setting("master_salt")
        .ok_or_else(|| "尚未设置主密码".to_string())?;
    let salt = crypto::from_hex(&salt_hex).map_err(|e| e.to_string())?;
    let key = crypto::derive_key(&master, &salt);
    let verify = state.db.get_setting("master_verify").unwrap_or_default();
    if !crypto::verify_master(&key, &verify) {
        return Err("主密码错误".into());
    }
    state.master.set_key(key);
    log::info!("master: unlocked");
    Ok(())
}

/// 锁定：清除内存中的密钥。
#[tauri::command]
pub fn master_lock(state: State<'_, AppState>) -> Result<(), String> {
    state.master.clear_key();
    log::info!("master: locked");
    Ok(())
}

/// 清除主密码：验证后解密所有会话回明文并删除盐与校验。
#[tauri::command]
pub fn master_clear(master: String, state: State<'_, AppState>) -> Result<(), String> {
    let salt_hex = state
        .db
        .get_setting("master_salt")
        .ok_or_else(|| "尚未设置主密码".to_string())?;
    let salt = crypto::from_hex(&salt_hex).map_err(|e| e.to_string())?;
    let key = crypto::derive_key(&master, &salt);
    let verify = state.db.get_setting("master_verify").unwrap_or_default();
    if !crypto::verify_master(&key, &verify) {
        return Err("主密码错误".into());
    }
    decrypt_all_sessions(&state.db, &key)?;
    state.db.remove_setting("master_salt")?;
    state.db.remove_setting("master_verify")?;
    state.master.clear_key();
    log::info!("master: cleared");
    Ok(())
}

#[tauri::command]
pub async fn session_list(state: State<'_, AppState>) -> Result<Vec<Session>, String> {
    state.db.list_sessions()
}

#[tauri::command]
pub async fn session_create(
    mut input: SessionInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // 已设置主密码：未解锁时拒绝保存明文密码
    if state.db.get_setting("master_salt").is_some() {
        let key = state.master.key().ok_or_else(|| "已设置主密码，请先在设置中解锁".to_string())?;
        encrypt_session_fields(&mut input, &key);
    }
    state.db.create_session(input)
}

#[tauri::command]
pub async fn session_update(
    id: String,
    mut input: SessionInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if state.db.get_setting("master_salt").is_some() {
        let key = state.master.key().ok_or_else(|| "已设置主密码，请先在设置中解锁".to_string())?;
        encrypt_session_fields(&mut input, &key);
    }
    state.db.update_session(&id, input)
}

#[tauri::command]
pub async fn session_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db.delete_session(&id)
}

/// 导出全部会话与分组为 JSON 备份字符串。
/// 主密码已解锁时，密码字段会解密为明文（便于迁移到其他设备）；
/// 未解锁或未设置主密码时，导出数据库中当前存储的值。
#[tauri::command]
pub async fn sessions_export(state: State<'_, AppState>) -> Result<String, String> {
    let groups = state.db.list_groups()?;
    let mut sessions = state.db.list_sessions()?;
    if let Some(key) = state.master.key() {
        for s in sessions.iter_mut() {
            if let Some(p) = &s.password {
                if crypto::is_encrypted(p) {
                    s.password = Some(crypto::decrypt(&key, p).unwrap_or_else(|_| p.clone()));
                }
            }
            if let Some(p) = &s.private_key_passphrase {
                if crypto::is_encrypted(p) {
                    s.private_key_passphrase = Some(crypto::decrypt(&key, p).unwrap_or_else(|_| p.clone()));
                }
            }
        }
    }
    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let out = SessionExport {
        app: "termix".into(),
        version: 1,
        exported_at,
        groups,
        sessions,
    };
    log::info!("export: {} sessions, {} groups", out.sessions.len(), out.groups.len());
    serde_json::to_string_pretty(&out).map_err(|e| e.to_string())
}

/// 从 JSON 备份导入会话与分组。
/// 分组按名称去重（同名复用），会话按名称去重（同名跳过）。
/// 密码字段：已是密文则原样保留；明文且已设置主密码时需先解锁（按现有加密策略加密存储）。
#[tauri::command]
pub async fn sessions_import(
    content: String,
    state: State<'_, AppState>,
) -> Result<SessionImportResult, String> {
    let parsed: SessionExport =
        serde_json::from_str(&content).map_err(|e| format!("JSON 格式错误: {e}"))?;
    if parsed.app != "termix" {
        return Err("不是 Termix 会话备份文件（缺少 app 标识）".into());
    }
    if parsed.version != 1 {
        return Err(format!("暂不支持备份版本 v{}", parsed.version));
    }
    let existing_groups = state.db.list_groups()?;
    let existing_sessions = state.db.list_sessions()?;

    // 分组：同名复用，否则新建，记录旧 id -> 新 id 映射
    let mut group_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut groups_created = 0;
    for g in &parsed.groups {
        if let Some(e) = existing_groups.iter().find(|e| e.name == g.name) {
            group_map.insert(g.id.clone(), e.id.clone());
        } else {
            let new_id = state.db.create_group(GroupInput {
                name: g.name.clone(),
                parent_id: None,
            })?;
            group_map.insert(g.id.clone(), new_id.clone());
            groups_created += 1;
        }
    }

    // 会话：同名跳过，否则创建（group_id 映射到新分组）
    let mut sessions_created = 0;
    let mut sessions_skipped = 0;
    for s in &parsed.sessions {
        if existing_sessions.iter().any(|e| e.name == s.name) {
            sessions_skipped += 1;
            continue;
        }
        let mut input = session_to_input(s);
        input.group_id = s.group_id.as_ref().and_then(|old| group_map.get(old).cloned());
        if state.db.get_setting("master_salt").is_some() {
            let key = state.master.key().ok_or_else(|| "已设置主密码，请先在设置中解锁".to_string())?;
            encrypt_session_fields(&mut input, &key);
        }
        state.db.create_session(input)?;
        sessions_created += 1;
    }
    log::info!(
        "import: groups_created={groups_created}, sessions_created={sessions_created}, sessions_skipped={sessions_skipped}"
    );
    Ok(SessionImportResult {
        groups_created,
        sessions_created,
        sessions_skipped,
    })
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
    let mut session = state
        .db
        .list_sessions()?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "session not found".to_string())?;
    // 解密会话密码字段
    if let Some(key) = state.master.key() {
        if let Some(p) = &session.password {
            if crypto::is_encrypted(p) {
                session.password = Some(crypto::decrypt(&key, p)?);
            }
        }
        if let Some(p) = &session.private_key_passphrase {
            if crypto::is_encrypted(p) {
                session.private_key_passphrase = Some(crypto::decrypt(&key, p)?);
            }
        }
    } else if session.password.as_deref().map(crypto::is_encrypted).unwrap_or(false)
        || session
            .private_key_passphrase
            .as_deref()
            .map(crypto::is_encrypted)
            .unwrap_or(false)
    {
        return Err("会话已加密，请在「设置 → 安全」中输入主密码解锁后重试".into());
    }
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
pub async fn sftp_upload_dir(
    app: AppHandle,
    connection_id: String,
    session_id: String,
    local_path: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state
        .sftp
        .upload_dir(app, &connection_id, &session_id, &local_path, &remote_path)
        .await
}

#[tauri::command]
pub async fn sftp_download_dir(
    app: AppHandle,
    connection_id: String,
    session_id: String,
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state
        .sftp
        .download_dir(app, &connection_id, &session_id, &remote_path, &local_path)
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

#[tauri::command]
pub async fn transfer_pause(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.sftp.transfer_pause(&task_id).await
}

#[tauri::command]
pub async fn transfer_resume(
    app: AppHandle,
    task_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.sftp.transfer_resume(app, &task_id).await
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
            "top -bn1 | sed -n '3p'; echo ---; free -b | sed -n '2p'; echo ---; df -k; echo ---; awk 'NR>2 {rx+=$2;tx+=$10} END {print rx, tx}' /proc/net/dev; echo ---; awk 'FNR>1 {n++} END {print n+0}' /proc/net/tcp /proc/net/tcp6 2>/dev/null",
        )
        .await?;
    let parts: Vec<&str> = out.split("---").collect();
    let cpu = parts.first().and_then(|s| parse_first_f64(s)).unwrap_or(0.0);
    let (mem_used, mem_total) = parse_mem(parts.get(1).unwrap_or(&""));
    let disks = parse_disks(parts.get(2).unwrap_or(&""));
    let disk_used_pct = disks
        .iter()
        .find(|d| d.mount == "/")
        .map(|d| d.pct)
        .or_else(|| disks.first().map(|d| d.pct))
        .unwrap_or(0.0);
    let (net_rx, net_tx) = parse_net(parts.get(3).unwrap_or(&""));
    let net_conns = parse_conns(parts.get(4).unwrap_or(&""));
    Ok(Metrics {
        cpu,
        mem_used,
        mem_total,
        disk_used_pct,
        net_rx,
        net_tx,
        net_conns,
        disks,
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

/// 解析 `df -k` 多行输出，返回真实磁盘分区（排除 tmpfs 等非块设备）。
fn parse_disks(s: &str) -> Vec<DiskInfo> {
    s.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 6 || f[0] == "Filesystem" || !f[0].starts_with('/') {
                return None;
            }
            let total: u64 = f[1].parse().ok()?;
            let used: u64 = f[2].parse().ok()?;
            let pct: f64 = f[4].trim_end_matches('%').parse().ok()?;
            Some(DiskInfo {
                mount: f[5..].join(" "),
                total: total * 1024, // df -k 单位为 KB
                used: used * 1024,
                pct,
            })
        })
        .collect()
}

fn parse_conns(s: &str) -> u32 {
    s.split_whitespace()
        .next()
        .and_then(|t| t.parse().ok())
        .unwrap_or(0)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_first_f64_basic() {
        assert_eq!(parse_first_f64("%Cpu(s):  12.5 us"), Some(12.5));
        assert_eq!(parse_first_f64("12.5"), Some(12.5));
    }

    #[test]
    fn parse_first_f64_edge() {
        // 空串、无数字返回 None
        assert_eq!(parse_first_f64(""), None);
        assert_eq!(parse_first_f64("no digits here"), None);
        // 已知行为：`-` 被当作分隔符，负号被丢弃，返回绝对值
        assert_eq!(parse_first_f64("-1.5"), Some(1.5));
        // 非法数字片段
        assert_eq!(parse_first_f64("abc 1.2.3 def"), None);
    }

    #[test]
    fn parse_mem_basic() {
        let out = "Mem:  8388608 4194304 4194304 0 0 0";
        assert_eq!(parse_mem(out), (4194304, 8388608));
    }

    #[test]
    fn parse_mem_malformed() {
        assert_eq!(parse_mem(""), (0, 0));
        // 首字段不是 Mem: 时不解析
        assert_eq!(parse_mem("Swap: 100 50"), (0, 0));
        // 字段数不足
        assert_eq!(parse_mem("Mem: 10"), (0, 0));
    }

    #[test]
    fn parse_disks_basic() {
        let out = "\
Filesystem     1K-blocks    Used Available Use% Mounted on
/dev/disk1s1 1024000000 300000000 700000000 31% /
/dev/disk1s2  512000000  200000000 300000000 45% /data
tmpfs           1000000    100000     900000  10% /run";
        let disks = parse_disks(out);
        // 排除 tmpfs（非 / 开头设备）与表头
        assert_eq!(disks.len(), 2);
        assert_eq!(disks[0].mount, "/");
        assert_eq!(disks[0].pct, 31.0);
        assert_eq!(disks[0].total, 1024000000 * 1024);
        assert_eq!(disks[0].used, 300000000 * 1024);
        assert_eq!(disks[1].mount, "/data");
    }

    #[test]
    fn parse_disks_mount_with_spaces() {
        let out = "/dev/sdb1 100 50 50 50% /mnt/my data";
        let disks = parse_disks(out);
        assert_eq!(disks.len(), 1);
        assert_eq!(disks[0].mount, "/mnt/my data");
    }

    #[test]
    fn parse_disks_empty() {
        assert!(parse_disks("").is_empty());
        assert!(parse_disks("Filesystem 1K-blocks Used Available Use% Mounted on").is_empty());
    }

    #[test]
    fn parse_conns_basic() {
        assert_eq!(parse_conns("42"), 42);
        assert_eq!(parse_conns(" 7 "), 7);
    }

    #[test]
    fn parse_conns_malformed() {
        assert_eq!(parse_conns(""), 0);
        assert_eq!(parse_conns("abc"), 0);
    }

    #[test]
    fn parse_net_basic() {
        assert_eq!(parse_net("1024 2048"), (1024, 2048));
    }

    #[test]
    fn parse_net_malformed() {
        assert_eq!(parse_net(""), (0, 0));
        assert_eq!(parse_net("only-one"), (0, 0));
        // 非法数字按 0 处理
        assert_eq!(parse_net("abc def"), (0, 0));
    }
}
