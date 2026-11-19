use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use crate::crypto;
use crate::db::Db;
use crate::forward::ForwardService;
use crate::models::{
    CommandHistory, DiskInfo, ForwardRule, ForwardRuleInput, Group, GroupInput, MasterStatus,
    Metrics, ProcInfo, Session, SessionExport, SessionImportResult, SessionInput, Snippet,
    SnippetInput, SysInfo,
};
use crate::sftp::{SftpItem, SftpService, TransferTask};
use crate::ssh::{HostKeyStatus, SshManager};

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
    /// 应用数据目录：自动备份（backups/）落盘位置
    pub data_dir: std::path::PathBuf,
    /// 默认下载目录：Windows 安装版位于安装目录下的 downloads
    pub default_download_dir: std::path::PathBuf,
    /// 当前数据目录是否位于安装目录（Windows 便携模式）
    pub portable: bool,
}

impl AppState {
    pub fn new(
        db: Db,
        data_dir: std::path::PathBuf,
        default_download_dir: std::path::PathBuf,
        portable: bool,
    ) -> Self {
        let ssh = Arc::new(SshManager::new());
        let sftp = SftpService::new(ssh.clone());
        let forward = ForwardService::new(ssh.clone());
        Self {
            db,
            ssh,
            sftp,
            forward,
            master: MasterService::new(),
            data_dir,
            default_download_dir,
            portable,
        }
    }

    pub fn app_paths(&self) -> AppPaths {
        let configured = self
            .db
            .get_setting("download_dir")
            .filter(|path| !path.trim().is_empty())
            .filter(|path| PathBuf::from(path).is_absolute());
        let download_dir = configured
            .map(PathBuf::from)
            .unwrap_or_else(|| self.default_download_dir.clone());
        let _ = std::fs::create_dir_all(&download_dir);
        self.write_download_marker(&download_dir);
        AppPaths {
            data_dir: self.data_dir.to_string_lossy().into_owned(),
            default_download_dir: self.default_download_dir.to_string_lossy().into_owned(),
            download_dir: download_dir.to_string_lossy().into_owned(),
            portable: self.portable,
        }
    }

    /// 卸载器无法读取 SQLite，这里把自定义下载目录写成 UTF-16LE 标记文件，
    /// 供 NSIS 在卸载时判断是否需要清理安装目录之外的用户下载目录。
    fn write_download_marker(&self, download_dir: &std::path::Path) {
        let marker = self.data_dir.join("download_dir.txt");
        if download_dir == self.default_download_dir {
            let _ = std::fs::remove_file(marker);
            return;
        }
        let text = download_dir.to_string_lossy().to_string();
        let mut bytes = Vec::with_capacity(text.len() * 2);
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        if let Err(e) = std::fs::write(&marker, bytes) {
            log::warn!("write download dir marker failed: {e}");
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub data_dir: String,
    pub default_download_dir: String,
    pub download_dir: String,
    pub portable: bool,
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
        jump_session_id: s.jump_session_id.clone(),
        agent_forward: Some(s.agent_forward),
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

/// 在内存中解密会话的密码字段（不写库）；任一条失败则整体报错。
fn decrypt_session_fields(input: &mut SessionInput, key: &crypto::MasterKey) -> Result<(), String> {
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
    Ok(())
}

/// 在内存中解密 Session 的密码字段（导出/连接时对完整会话对象使用）。
fn decrypt_session_secrets(s: &mut Session, key: &crypto::MasterKey) -> Result<(), String> {
    if let Some(p) = &s.password {
        if crypto::is_encrypted(p) {
            s.password = Some(
                crypto::decrypt(key, p).map_err(|e| format!("会话「{}」密码解密失败：{e}", s.name))?,
            );
        }
    }
    if let Some(p) = &s.private_key_passphrase {
        if crypto::is_encrypted(p) {
            s.private_key_passphrase = Some(
                crypto::decrypt(key, p)
                    .map_err(|e| format!("会话「{}」私钥密码解密失败：{e}", s.name))?,
            );
        }
    }
    Ok(())
}

/// 在内存中对全部会话字段执行转换（不写库）；任一条失败则整体报错。
/// 返回 (会话 id, 转换后的输入) 列表，调用方确认全部成功后再统一写库，
/// 避免「边转换边落盘」导致解密失败时部分会话已变为明文。
fn transform_all_sessions(
    db: &Db,
    f: impl Fn(&mut SessionInput) -> Result<(), String>,
) -> Result<Vec<(String, SessionInput)>, String> {
    db.list_sessions()?
        .into_iter()
        .map(|s| {
            let mut input = session_to_input(&s);
            f(&mut input)?;
            Ok((s.id, input))
        })
        .collect()
}

/// 对所有会话执行转换并统一写库：先在内存中全部转换成功，再一次性落盘。
/// 转换（如解密）任一条失败则整体报错、不写库，保证原子性。
fn transform_and_persist(
    db: &Db,
    f: impl Fn(&mut SessionInput) -> Result<(), String>,
) -> Result<(), String> {
    let inputs = transform_all_sessions(db, f)?;
    for (id, input) in inputs {
        db.update_session(&id, input)?;
    }
    Ok(())
}

/// 校验导入的会话密文：无法用当前主密钥解密的密文（来自其他设备）清空该字段，
/// 避免导入后永远无法解密。key 为 None（未设置主密码）时，任何密文都无法解密，
/// 全部清空。返回被清空的字段数量。
fn sanitize_import_secrets(input: &mut SessionInput, key: Option<&crypto::MasterKey>) -> usize {
    let mut cleared = 0;
    if let Some(p) = &input.password {
        let usable = match key {
            Some(k) => !crypto::is_encrypted(p) || crypto::decrypt(k, p).is_ok(),
            None => !crypto::is_encrypted(p),
        };
        if !usable {
            input.password = None;
            cleared += 1;
        }
    }
    if let Some(p) = &input.private_key_passphrase {
        let usable = match key {
            Some(k) => !crypto::is_encrypted(p) || crypto::decrypt(k, p).is_ok(),
            None => !crypto::is_encrypted(p),
        };
        if !usable {
            input.private_key_passphrase = None;
            cleared += 1;
        }
    }
    cleared
}

/// 构建导入分组映射（旧分组 id -> 新分组 id）：同名复用（含备份文件内部重名），
/// 否则新建分组。返回映射与新建分组数量。
fn resolve_import_groups(
    db: &Db,
    parsed_groups: &[Group],
    existing_groups: &[Group],
) -> Result<(std::collections::HashMap<String, String>, usize), String> {
    let mut group_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut group_name_to_id: std::collections::HashMap<String, String> = existing_groups
        .iter()
        .map(|g| (g.name.clone(), g.id.clone()))
        .collect();
    let mut groups_created = 0;
    for g in parsed_groups {
        if let Some(existing) = group_name_to_id.get(&g.name) {
            group_map.insert(g.id.clone(), existing.clone());
            continue;
        }
        let new_id = db.create_group(GroupInput {
            name: g.name.clone(),
            parent_id: None,
        })?;
        group_map.insert(g.id.clone(), new_id.clone());
        group_name_to_id.insert(g.name.clone(), new_id.clone());
        groups_created += 1;
    }
    Ok((group_map, groups_created))
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
    // 已设置过：验证旧密码并先在内存中解密全部会话（失败不落盘）
    let old_key = if let Some(hex) = state.db.get_setting("master_salt") {
        let old = old_master.ok_or_else(|| "请提供当前主密码".to_string())?;
        let salt = crypto::from_hex(&hex).map_err(|e| e.to_string())?;
        let old_key = crypto::derive_key(&old, &salt);
        let verify = state.db.get_setting("master_verify").unwrap_or_default();
        if !crypto::verify_master(&old_key, &verify) {
            return Err("当前主密码错误".into());
        }
        Some(old_key)
    } else {
        None
    };
    // 新盐 + 新密钥
    let salt = crypto::gen_salt();
    let key = crypto::derive_key(&master, &salt);
    // 全部转换在内存中完成，全部成功后才统一写库（原子性）
    transform_and_persist(&state.db, |input| {
        if let Some(ok) = &old_key {
            decrypt_session_fields(input, ok)?;
        }
        encrypt_session_fields(input, &key);
        Ok(())
    })?;
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
    // 先在内存中全部解密成功，再统一写库（失败不落盘）
    transform_and_persist(&state.db, |input| decrypt_session_fields(input, &key))?;
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

/// 同一分组（无分组视为同一组）内连接名称唯一性校验。
fn ensure_session_name_unique(
    db: &Db,
    name: &str,
    group_id: Option<&str>,
    exclude_id: Option<&str>,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("连接名称不能为空".to_string());
    }
    for s in db.list_sessions()? {
        if let Some(id) = exclude_id {
            if s.id == id {
                continue;
            }
        }
        if s.name == name && s.group_id.as_deref() == group_id {
            return Err(format!("同一分组下已存在名为「{name}」的连接"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn session_create(
    mut input: SessionInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    ensure_session_name_unique(&state.db, &input.name, input.group_id.as_deref(), None)?;
    // 已设置主密码：未解锁时拒绝保存明文密码
    if state.db.get_setting("master_salt").is_some() {
        let key = state.master.key().ok_or_else(|| "已设置主密码，请先在设置中解锁".to_string())?;
        encrypt_session_fields(&mut input, &key);
    }
    let id = state.db.create_session(input)?;
    snapshot_sessions(&state);
    Ok(id)
}

#[tauri::command]
pub async fn session_update(
    id: String,
    mut input: SessionInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ensure_session_name_unique(&state.db, &input.name, input.group_id.as_deref(), Some(&id))?;
    if state.db.get_setting("master_salt").is_some() {
        let key = state.master.key().ok_or_else(|| "已设置主密码，请先在设置中解锁".to_string())?;
        encrypt_session_fields(&mut input, &key);
    }
    state.db.update_session(&id, input)?;
    snapshot_sessions(&state);
    Ok(())
}

#[tauri::command]
pub async fn session_move(
    id: String,
    group_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.move_session(&id, group_id.as_deref())?;
    snapshot_sessions(&state);
    Ok(())
}

#[tauri::command]
pub async fn session_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db.delete_session(&id)?;
    snapshot_sessions(&state);
    Ok(())
}

/// 导出全部会话与分组为 JSON 备份字符串。
/// 主密码已解锁时，密码字段会解密为明文（便于迁移到其他设备）；
/// 未解锁或未设置主密码时，导出数据库中当前存储的值。
#[tauri::command]
pub async fn sessions_export(state: State<'_, AppState>) -> Result<String, String> {
    let out = build_session_export(&state.db, &state.master)?;
    log::info!("export: {} sessions, {} groups", out.sessions.len(), out.groups.len());
    serde_json::to_string_pretty(&out).map_err(|e| e.to_string())
}

/// 组装备份内容（导出与自动备份共用）：分组 + 会话列表。
/// 主密码已解锁时密码字段解密为明文，否则保留数据库当前存储值。
fn build_session_export(db: &Db, master: &MasterService) -> Result<SessionExport, String> {
    let groups = db.list_groups()?;
    let mut sessions = db.list_sessions()?;
    if let Some(key) = master.key() {
        for s in sessions.iter_mut() {
            decrypt_session_secrets(s, &key)?;
        }
    }
    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(SessionExport {
        app: "termix".into(),
        version: 1,
        exported_at,
        groups,
        sessions,
    })
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

    // 分组：同名复用（含备份文件内部重名），否则新建，记录旧 id -> 新 id 映射
    let (group_map, groups_created) = resolve_import_groups(&state.db, &parsed.groups, &existing_groups)?;

    // 会话：同名跳过（含备份文件内部重名），否则创建（group_id 映射到新分组）
    // 校验密文是否可用：已设置主密码且解锁时用当前密钥校验（其他设备导出的密文无法解密则清空）；
    // 未设置主密码时任何密文都无法解密，同样清空，避免留下永远不可用的数据（连接必然失败）。
    let master_key = state.master.key();
    let mut sessions_created = 0;
    let mut sessions_skipped = 0;
    let mut secrets_cleared = 0;
    let mut used_session_names: std::collections::HashSet<String> =
        existing_sessions.iter().map(|s| s.name.clone()).collect();
    for s in &parsed.sessions {
        let mut input = session_to_input(s);
        input.group_id = s.group_id.as_ref().and_then(|old| group_map.get(old).cloned());
        let has_salt = state.db.get_setting("master_salt").is_some();
        match insert_imported_session(
            &state.db,
            master_key.as_ref(),
            has_salt,
            input,
            &mut used_session_names,
        )? {
            ImportInsert::Created(cleared) => {
                sessions_created += 1;
                secrets_cleared += cleared;
            }
            ImportInsert::Skipped => sessions_skipped += 1,
        }
    }
    log::info!(
        "import: groups_created={groups_created}, sessions_created={sessions_created}, sessions_skipped={sessions_skipped}, secrets_cleared={secrets_cleared}"
    );
    // 导入是批量变更：落一次自动备份
    snapshot_sessions(&state);
    Ok(SessionImportResult {
        groups_created,
        sessions_created,
        sessions_skipped,
        secrets_cleared,
    })
}

/// 导入单条会话的落库结果
enum ImportInsert {
    Created(usize),
    Skipped,
}

/// 导入落库共用：同名跳过；密文不可用则清空；
/// 已设置主密码时必须先解锁（明文按现有策略加密存储）。
/// 返回落库结果（新建附带被清空的秘密字段数）。
fn insert_imported_session(
    db: &Db,
    master_key: Option<&crypto::MasterKey>,
    has_master_salt: bool,
    mut input: SessionInput,
    used_session_names: &mut std::collections::HashSet<String>,
) -> Result<ImportInsert, String> {
    if !used_session_names.insert(input.name.clone()) {
        return Ok(ImportInsert::Skipped);
    }
    let cleared = if has_master_salt {
        let key = master_key.ok_or_else(|| "已设置主密码，请先在设置中解锁".to_string())?;
        let n = sanitize_import_secrets(&mut input, Some(key));
        encrypt_session_fields(&mut input, key);
        n
    } else {
        sanitize_import_secrets(&mut input, None)
    };
    db.create_session(input)?;
    Ok(ImportInsert::Created(cleared))
}

/// ---- 会话自动备份 ----
///
/// 每次会话/分组变更后落一次 JSON 快照到 `<data_dir>/backups/`，
/// 文件名 `sessions-<毫秒时间戳>-<原因>.json`，仅保留最新 BACKUP_KEEP 份。
/// 内容与手动导出一致（主密码未解锁时密码字段保持加密存储值）。
const BACKUP_KEEP: usize = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub name: String,
    pub size: u64,
    /// 文件修改时间（毫秒时间戳，前端格式化展示）
    pub modified_ms: i64,
}

fn backup_dir(state: &State<'_, AppState>) -> std::path::PathBuf {
    state.data_dir.join("backups")
}

/// 备份保留：已按新到旧排序的文件名中，超出保留数的待删列表（纯函数，可测试）。
fn select_backup_prune(sorted_desc: &[String], keep: usize) -> Vec<String> {
    sorted_desc.iter().skip(keep).cloned().collect()
}

/// 会话变更后调用：失败只记日志，不阻断主流程。
fn snapshot_sessions(state: &State<'_, AppState>) {
    if let Err(e) = snapshot_sessions_inner(state, "auto") {
        log::warn!("auto backup failed: {e}");
    }
}

fn snapshot_sessions_inner(state: &State<'_, AppState>, reason: &str) -> Result<(), String> {
    let out = build_session_export(&state.db, &state.master)?;
    write_backup_snapshot(&backup_dir(state), &out, reason, BACKUP_KEEP).map(|_| ())
}

/// 落一份备份快照并按保留数滚动清理（纯文件操作，便于单元测试）。
fn write_backup_snapshot(
    dir: &std::path::Path,
    out: &SessionExport,
    reason: &str,
    keep: usize,
) -> Result<String, String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!("sessions-{millis:015}-{reason}.json");
    let json = serde_json::to_string_pretty(out).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(&name), json).map_err(|e| e.to_string())?;
    // 滚动保留：按文件名倒序（毫秒时间戳同序）删超出的
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("sessions-") && n.ends_with(".json"))
        .collect();
    names.sort();
    names.reverse();
    for stale in select_backup_prune(&names, keep) {
        if let Err(e) = std::fs::remove_file(dir.join(&stale)) {
            log::warn!("prune backup {stale} failed: {e}");
        }
    }
    log::info!("backup snapshot saved: {name}");
    Ok(name)
}

/// 列出本地自动/手动备份（新到旧）。
#[tauri::command]
pub async fn backup_list(state: State<'_, AppState>) -> Result<Vec<BackupFile>, String> {
    let dir = backup_dir(&state);
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut out: Vec<BackupFile> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name().to_string_lossy().starts_with("sessions-")
                && e.path().extension().is_some_and(|x| x == "json")
        })
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some(BackupFile {
                name: e.file_name().to_string_lossy().into_owned(),
                size: meta.len(),
                modified_ms: meta
                    .modified()
                    .ok()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            })
        })
        .collect();
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// 从指定备份恢复（与导入同一套去重/加密规则；恢复前先落一次当前快照兜底）。
#[tauri::command]
pub async fn backup_restore(
    name: String,
    state: State<'_, AppState>,
) -> Result<SessionImportResult, String> {
    if name.contains('/') || name.contains('\\') || !name.starts_with("sessions-") {
        return Err("非法备份文件名".to_string());
    }
    let path = backup_dir(&state).join(&name);
    if !path.starts_with(backup_dir(&state)) {
        return Err("非法备份路径".to_string());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("读取备份失败：{e}"))?;
    // 先给当前数据落快照，恢复出错/反悔可回滚
    if let Err(e) = snapshot_sessions_inner(&state, "before-restore") {
        log::warn!("pre-restore snapshot failed: {e}");
    }
    sessions_import(content, state).await
}

/// 手动立即备份一次。
#[tauri::command]
pub async fn backup_now(state: State<'_, AppState>) -> Result<String, String> {
    snapshot_sessions_inner(&state, "manual")?;
    Ok("已备份当前会话配置".to_string())
}

/// 读取本机默认 `~/.ssh/config` 内容（不存在则报错，前端引导改用文件选择）。
#[tauri::command]
pub async fn ssh_config_read_default() -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法定位用户主目录".to_string())?;
    let path = std::path::Path::new(&home).join(".ssh").join("config");
    std::fs::read_to_string(&path)
        .map_err(|_| "未找到 ~/.ssh/config（可改用文件选择导入）".to_string())
}

/// 导入 ssh config 文本：解析 Host 块批量建会话（同名跳过），
/// 有 IdentityFile 的走私钥认证，否则走密码认证（密码留空，连接时填写）。
/// 成功导入的会话统一归入「SSH 导入」分组，方便辨认整理。
#[tauri::command]
pub async fn ssh_config_import(
    content: String,
    state: State<'_, AppState>,
) -> Result<SessionImportResult, String> {
    use crate::sshconfig::parse_ssh_config;
    let hosts = parse_ssh_config(&content);
    if hosts.is_empty() {
        return Err("未解析到可用主机（仅支持 Host/HostName/User/Port/IdentityFile）".to_string());
    }
    let existing_sessions = state.db.list_sessions()?;
    let mut used_session_names: std::collections::HashSet<String> =
        existing_sessions.iter().map(|s| s.name.clone()).collect();
    let master_key = state.master.key();
    let has_salt = state.db.get_setting("master_salt").is_some();
    let mut sessions_created = 0;
    let mut sessions_skipped = 0;
    let mut group_id: Option<String> = None;
    for h in &hosts {
        if used_session_names.contains(&h.name) {
            sessions_skipped += 1;
            continue;
        }
        let (auth_type, private_key_path) = match &h.identity_file {
            Some(p) => ("key".to_string(), Some(p.clone())),
            None => ("password".to_string(), None),
        };
        // 首个待建会话触发分组准备（同名复用，不存在则创建）
        let gid = match group_id.clone() {
            Some(g) => Some(g),
            None => {
                let existing = state.db.list_groups()?;
                let g = match existing.iter().find(|g| g.name == "SSH 导入") {
                    Some(g) => g.id.clone(),
                    None => state.db.create_group(crate::models::GroupInput {
                        name: "SSH 导入".into(),
                        parent_id: None,
                    })?,
                };
                group_id = Some(g.clone());
                Some(g)
            }
        };
        let input = crate::models::SessionInput {
            name: h.name.clone(),
            host: h.hostname.clone(),
            port: h.port,
            username: h.user.clone().unwrap_or_default(),
            auth_type,
            password: None,
            private_key_path,
            private_key_passphrase: None,
            group_id: gid,
            memo: Some("从 ssh config 导入".into()),
            encoding: Some("utf-8".into()),
            jump_session_id: None,
            agent_forward: None,
        };
        match insert_imported_session(
            &state.db,
            master_key.as_ref(),
            has_salt,
            input,
            &mut used_session_names,
        )? {
            ImportInsert::Created(_) => sessions_created += 1,
            ImportInsert::Skipped => sessions_skipped += 1,
        }
    }
    log::info!("ssh-config import: created={sessions_created}, skipped={sessions_skipped}");
    snapshot_sessions(&state);
    Ok(SessionImportResult {
        groups_created: if sessions_created > 0 { 1 } else { 0 },
        sessions_created,
        sessions_skipped,
        secrets_cleared: 0,
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
    let id = state.db.create_group(input)?;
    snapshot_sessions(&state);
    Ok(id)
}

#[tauri::command]
pub async fn group_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db.delete_group(&id)?;
    snapshot_sessions(&state);
    Ok(())
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
        decrypt_session_secrets(&mut session, &key)?;
    } else if session.password.as_deref().map(crypto::is_encrypted).unwrap_or(false)
        || session
            .private_key_passphrase
            .as_deref()
            .map(crypto::is_encrypted)
            .unwrap_or(false)
    {
        return Err("会话已加密，请在「设置 → 安全」中输入主密码解锁后重试".into());
    }
    let known_fingerprint = state.db.get_host_key(&session.host, session.port)?;
    // 跳板机：解析为另一已保存会话（同样走主密码解密与主机密钥查询）
    let jump = match session.jump_session_id.as_deref().filter(|v| !v.is_empty()) {
        None => None,
        Some(jump_id) => {
            let mut jump_session = state
                .db
                .list_sessions()?
                .into_iter()
                .find(|s| s.id == jump_id)
                .ok_or_else(|| "跳板机会话不存在（可能已被删除）".to_string())?;
            if let Some(key) = state.master.key() {
                decrypt_session_secrets(&mut jump_session, &key)?;
            } else if jump_session.password.as_deref().map(crypto::is_encrypted).unwrap_or(false)
                || jump_session
                    .private_key_passphrase
                    .as_deref()
                    .map(crypto::is_encrypted)
                    .unwrap_or(false)
            {
                return Err("跳板机会话已加密，请先在「设置 → 安全」中输入主密码解锁后重试".into());
            }
            if jump_session.id == id {
                return Err("跳板机不能是自身".to_string());
            }
            let jump_fp = state
                .db
                .get_host_key(&jump_session.host, jump_session.port)?;
            Some(crate::ssh::JumpTarget {
                session: jump_session,
                known_fingerprint: jump_fp,
            })
        }
    };
    // 本次连接独立的主机密钥校验容器：并发连接互不干扰
    let pending = Arc::new(Mutex::new(None));
    match state
        .ssh
        .connect(session.clone(), jump, known_fingerprint, pending.clone())
        .await
    {
        Ok(connection_id) => {
            state.db.touch_session(&id)?;
            Ok(connection_id)
        }
        Err(e) => {
            // 主机密钥校验被拒：区分「首次未信任」与「密钥变更」
            if let Some(status) = pending.lock().await.take() {
                return Err(match status {
                    HostKeyStatus::Unverified { fingerprint } => {
                        format!("HOST_KEY_UNVERIFIED:{fingerprint}")
                    }
                    HostKeyStatus::Mismatch { fingerprint, expected } => {
                        format!("HOST_KEY_CHANGED:{fingerprint}:{expected}")
                    }
                });
            }
            Err(e)
        }
    }
}

/// 前端回填键盘交互认证（2FA）的应答
#[tauri::command]
pub async fn auth_respond(
    auth_id: String,
    responses: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.auth_respond(&auth_id, responses).await
}

/// 前端取消键盘交互认证（2FA）
#[tauri::command]
pub async fn auth_cancel(auth_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.ssh.auth_cancel(&auth_id).await
}

/// 信任并保存指定主机的主机密钥指纹（TOFU 首次确认）。
#[tauri::command]
pub async fn host_key_accept(
    host: String,
    port: u32,
    fingerprint: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.set_host_key(&host, port as u16, &fingerprint)
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
pub async fn sftp_list_enriched(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<SftpItem>, String> {
    state.sftp.list_enriched(&connection_id, &path).await
}

#[tauri::command]
pub async fn sftp_cwd(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.sftp.cwd(&connection_id).await
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
pub async fn sftp_create_file(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.sftp.create_file(&connection_id, &path).await
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

#[tauri::command]
pub fn local_ensure_dir(path: String) -> Result<(), String> {
    crate::sftp::local_ensure_dir(&path)
}

#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), String> {
    crate::sftp::local_mkdir(&path)
}

#[tauri::command]
pub fn local_rename(old_path: String, new_path: String) -> Result<(), String> {
    crate::sftp::local_rename(&old_path, &new_path)
}

#[tauri::command]
pub fn local_delete(path: String, is_dir: bool) -> Result<(), String> {
    crate::sftp::local_delete(&path, is_dir)
}

#[tauri::command]
pub fn local_open_path(path: String) -> Result<(), String> {
    crate::sftp::local_open_path(&path)
}

#[tauri::command]
pub fn app_paths(state: State<'_, AppState>) -> AppPaths {
    state.app_paths()
}

#[tauri::command]
pub fn download_dir_set(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<AppPaths, String> {
    let trimmed = path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(value) = trimmed {
        let path = PathBuf::from(&value);
        if !path.is_absolute() {
            return Err("下载目录必须是绝对路径".into());
        }
        std::fs::create_dir_all(&path).map_err(|e| format!("创建下载目录失败：{e}"))?;
        let probe = path.join(format!(".termix-write-test-{}", std::process::id()));
        std::fs::File::create(&probe).map_err(|e| format!("下载目录不可写：{e}"))?;
        let _ = std::fs::remove_file(&probe);
        state
            .db
            .set_setting("download_dir", &path.to_string_lossy())?;
    } else {
        state.db.remove_setting("download_dir")?;
    }
    Ok(state.app_paths())
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
            // df 默认遍历所有挂载点，访问不可达的网络文件系统（NFS）会长时间卡住，
            // 导致命令整体超时、磁盘数据缺失。加 -l（仅本地）避免访问网络挂载点。
            // 连接数：/proc/net/tcp（IPv4）+ /proc/net/tcp6（IPv6）中除表头外的行数，
            // 即系统当前全部 TCP socket 表项总数（含 LISTEN/ESTABLISHED/TIME_WAIT 等所有状态）。
            // 注意：不是文件句柄/进程句柄数，也不含 UDP 与 Unix socket；如按状态过滤可用
            // 'awk "NR>1 && $4==\"01\" {n++}"' 统计 ESTABLISHED 活跃连接。
            "top -bn1 | sed -n '3p'; echo ---; free -b | sed -n '2p'; echo ---; df -klP 2>/dev/null; echo ---; awk 'NR>2 {rx+=$2;tx+=$10} END {print rx, tx}' /proc/net/dev; echo ---; awk 'FNR>1 {n++} END {print n+0}' /proc/net/tcp /proc/net/tcp6 2>/dev/null; echo ---; head -n1 /proc/uptime 2>/dev/null; echo ---; head -n1 /proc/loadavg 2>/dev/null",
        )
        .await?;
    log::debug!(
        "monitor: conn={connection_id} raw output ({} bytes): {}",
        out.len(),
        out.chars().take(2000).collect::<String>()
    );
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
    let uptime = parts
        .get(5)
        .and_then(|s| parse_first_f64(s))
        .unwrap_or(0.0);
    let (load1, load5, load15) = parse_loadavg(parts.get(6).unwrap_or(&""));
    Ok(Metrics {
        cpu,
        mem_used,
        mem_total,
        disk_used_pct,
        net_rx,
        net_tx,
        net_conns,
        disks,
        uptime,
        load1,
        load5,
        load15,
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

/// 服务器系统信息：OS / 内核 / 架构 / CPU / 内存 / 磁盘。
#[tauri::command]
pub async fn system_info(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<SysInfo, String> {
    let out = state
        .ssh
        .exec_command(
            &connection_id,
            // df -l 仅本地文件系统，避免网络挂载点卡住
            "cat /etc/os-release 2>/dev/null | grep -E '^(PRETTY_NAME|VERSION_ID)='; echo ---; uname -r; echo ---; uname -m; echo ---; nproc 2>/dev/null; echo ---; grep -m1 -E 'model name|Processor|Hardware' /proc/cpuinfo 2>/dev/null; echo ---; free -b 2>/dev/null | sed -n '2p'; echo ---; df -klP 2>/dev/null",
        )
        .await?;
    let parts: Vec<&str> = out.split("---").collect();
    let mut os_name = String::new();
    let mut os_version = String::new();
    for line in parts.first().unwrap_or(&"").lines() {
        if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
            os_name = v.trim_matches('"').to_string();
        } else if let Some(v) = line.strip_prefix("VERSION_ID=") {
            os_version = v.trim_matches('"').to_string();
        }
    }
    let (mem_used, mem_total) = parse_mem(parts.get(5).unwrap_or(&""));
    Ok(SysInfo {
        os_name,
        os_version,
        kernel: parts.get(1).unwrap_or(&"").trim().to_string(),
        arch: parts.get(2).unwrap_or(&"").trim().to_string(),
        cpu_cores: parts.get(3).unwrap_or(&"").trim().parse().unwrap_or(0),
        cpu_model: parts.get(4).unwrap_or(&"").trim().to_string(),
        mem_total,
        mem_used,
        disks: parse_disks(parts.get(6).unwrap_or(&"")),
    })
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

/// 解析 /proc/loadavg：前三个字段为 1/5/15 分钟负载。
fn parse_loadavg(s: &str) -> (f64, f64, f64) {
    let f: Vec<&str> = s.split_whitespace().collect();
    if f.len() >= 3 {
        (
            f[0].parse().unwrap_or(0.0),
            f[1].parse().unwrap_or(0.0),
            f[2].parse().unwrap_or(0.0),
        )
    } else {
        (0.0, 0.0, 0.0)
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

    #[test]
    fn parse_loadavg_basic() {
        assert_eq!(parse_loadavg("0.52 0.58 0.59 1/123 456"), (0.52, 0.58, 0.59));
        assert_eq!(parse_loadavg(""), (0.0, 0.0, 0.0));
        assert_eq!(parse_loadavg("0.1 0.2"), (0.0, 0.0, 0.0));
    }

    // ---- 主密码核心逻辑（master_set / master_clear / 导入导出共用） ----

    fn test_db() -> crate::db::Db {
        crate::db::Db::open(":memory:").unwrap()
    }

    #[test]
    fn app_paths_uses_configured_download_dir() {
        let root = std::env::temp_dir().join(format!(
            "termix-app-paths-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let data_dir = root.join("data");
        let default_download_dir = root.join("downloads");
        std::fs::create_dir_all(&data_dir).unwrap();
        let state = AppState::new(
            test_db(),
            data_dir.clone(),
            default_download_dir.clone(),
            true,
        );

        let paths = state.app_paths();
        assert_eq!(paths.data_dir, data_dir.to_string_lossy().to_string());
        assert_eq!(
            paths.default_download_dir,
            default_download_dir.to_string_lossy().to_string()
        );
        assert_eq!(
            paths.download_dir,
            default_download_dir.to_string_lossy().to_string()
        );
        assert!(paths.portable);

        let custom = root.join("custom-downloads");
        state
            .db
            .set_setting("download_dir", &custom.to_string_lossy())
            .unwrap();
        assert_eq!(
            state.app_paths().download_dir,
            custom.to_string_lossy().to_string()
        );
        let marker = data_dir.join("download_dir.txt");
        let bytes = std::fs::read(&marker).unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        assert_eq!(
            String::from_utf16(&units).unwrap(),
            custom.to_string_lossy().to_string()
        );

        state
            .db
            .set_setting("download_dir", "relative/path")
            .unwrap();
        assert_eq!(
            state.app_paths().download_dir,
            default_download_dir.to_string_lossy().to_string()
        );
        assert!(!marker.exists());

        let _ = std::fs::remove_dir_all(root);
    }

    fn sess(name: &str, password: Option<&str>) -> crate::models::SessionInput {
        crate::models::SessionInput {
            name: name.into(),
            host: "192.168.1.10".into(),
            port: 22,
            username: "root".into(),
            auth_type: "password".into(),
            password: password.map(|p| p.to_string()),
            private_key_path: None,
            private_key_passphrase: None,
            group_id: None,
            memo: None,
            encoding: None,
            jump_session_id: None,
            agent_forward: None,
        }
    }

    /// master_set 的核心：全部会话先在内存中解密/加密成功，再统一写库；
    /// 任一条解密失败则整体报错，且库中数据保持原状（不出现部分明文落盘）。
    #[test]
    fn transform_and_persist_is_atomic_on_decrypt_failure() {
        let db = test_db();
        let key = crypto::derive_key("pw", b"salt");
        // 会话 A 用当前密钥正常加密
        let a_id = db.create_session(sess("a", Some("secret-a"))).unwrap();
        // 会话 B 混入「其他设备导出」的密文（用别的密钥加密，本机无法解密）
        let foreign_key = crypto::derive_key("other", b"salt");
        let foreign_ct = crypto::encrypt(&foreign_key, "secret-b");
        let b_id = db.create_session(sess("b", Some(&foreign_ct))).unwrap();

        // 首次加密：全部明文 → 密文
        transform_and_persist(&db, |input| {
            encrypt_session_fields(input, &key);
            Ok(())
        })
        .unwrap();
        let stored_a = db.list_sessions().unwrap().into_iter().find(|s| s.id == a_id).unwrap();
        assert!(crypto::is_encrypted(stored_a.password.as_deref().unwrap()));

        // 解密：B 的密文无法用当前密钥解密 → 整体失败
        let err = transform_and_persist(&db, |input| decrypt_session_fields(input, &key));
        assert!(err.is_err());

        // 原子性验证：A 仍为密文（未被解密落盘为明文）
        let stored_after = db.list_sessions().unwrap();
        let a_after = stored_after.iter().find(|s| s.id == a_id).unwrap();
        let b_after = stored_after.iter().find(|s| s.id == b_id).unwrap();
        assert!(crypto::is_encrypted(a_after.password.as_deref().unwrap()));
        assert!(crypto::is_encrypted(b_after.password.as_deref().unwrap()));
        // A 的密文仍可用原密钥解开
        let pt = crypto::decrypt(&key, a_after.password.as_deref().unwrap()).unwrap();
        assert_eq!(pt, "secret-a");
    }

    /// master_set 的改密核心：旧密钥解密 + 新密钥加密后，旧密钥不可解、新密钥可解。
    #[test]
    fn transform_and_persist_reencrypt_roundtrip() {
        let db = test_db();
        let old_key = crypto::derive_key("old", b"s");
        let new_key = crypto::derive_key("new", b"s");
        db.create_session(sess("a", Some("plain-a"))).unwrap();
        db.create_session(sess("b", Some("plain-b"))).unwrap();

        // 首次加密
        transform_and_persist(&db, |input| {
            encrypt_session_fields(input, &old_key);
            Ok(())
        })
        .unwrap();
        // 改密：解密（旧）→ 加密（新）
        transform_and_persist(&db, |input| {
            decrypt_session_fields(input, &old_key)?;
            encrypt_session_fields(input, &new_key);
            Ok(())
        })
        .unwrap();

        for s in db.list_sessions().unwrap() {
            let ct = s.password.unwrap();
            assert!(crypto::is_encrypted(&ct));
            assert!(crypto::decrypt(&new_key, &ct).is_ok(), "新密钥应能解密");
            assert!(crypto::decrypt(&old_key, &ct).is_err(), "旧密钥不应再能解密");
        }
    }

    /// 字段级加解密：明文→密文、已加密跳过、明文不变、错误密钥报错。
    #[test]
    fn session_fields_encrypt_decrypt() {
        let key = crypto::derive_key("pw", b"s");
        let mut input = sess("a", Some("secret"));
        encrypt_session_fields(&mut input, &key);
        assert!(crypto::is_encrypted(input.password.as_deref().unwrap()));
        assert_eq!(crypto::decrypt(&key, input.password.as_deref().unwrap()).unwrap(), "secret");

        // 已加密的字段加密时跳过（不重复加密）
        let ct_before = input.password.clone();
        encrypt_session_fields(&mut input, &key);
        assert_eq!(input.password, ct_before);

        // 解密回明文
        decrypt_session_fields(&mut input, &key).unwrap();
        assert_eq!(input.password.as_deref(), Some("secret"));
        assert!(!crypto::is_encrypted(input.password.as_deref().unwrap()));

        // 明文字段解密时保持不变
        let mut plain = sess("b", Some("raw"));
        decrypt_session_fields(&mut plain, &key).unwrap();
        assert_eq!(plain.password.as_deref(), Some("raw"));

        // 错误密钥解密报错
        let wrong = crypto::derive_key("bad", b"s");
        let mut again = sess("c", Some("x"));
        encrypt_session_fields(&mut again, &key);
        assert!(decrypt_session_fields(&mut again, &wrong).is_err());
    }

    /// 导入分组映射：备份文件内部同名分组只建一次；库内已有同名分组直接复用。
    #[test]
    fn resolve_import_groups_dedup_within_backup() {
        let db = test_db();
        // 库内已有分组「生产」
        let existing_id = db
            .create_group(crate::models::GroupInput {
                name: "生产".into(),
                parent_id: None,
            })
            .unwrap();
        let existing_groups = db.list_groups().unwrap();

        // 备份内：g1/g2 同名「生产」（复用已有），g3「测试」、g4「测试」（备份内重名只建一次）
        let parsed = vec![
            crate::models::Group { id: "g1".into(), name: "生产".into(), parent_id: None, ord: 0 },
            crate::models::Group { id: "g2".into(), name: "生产".into(), parent_id: None, ord: 0 },
            crate::models::Group { id: "g3".into(), name: "测试".into(), parent_id: None, ord: 0 },
            crate::models::Group { id: "g4".into(), name: "测试".into(), parent_id: None, ord: 0 },
        ];
        let (map, created) = resolve_import_groups(&db, &parsed, &existing_groups).unwrap();

        assert_eq!(created, 1, "仅「测试」需新建一次");
        assert_eq!(map.get("g1").unwrap(), &existing_id);
        assert_eq!(map.get("g2").unwrap(), &existing_id);
        assert_eq!(map.get("g3").unwrap(), map.get("g4").unwrap(), "备份内部重名映射到同一分组");
        // 库中最终只有两个分组
        assert_eq!(db.list_groups().unwrap().len(), 2);
    }

    /// 导入密文校验：无法用当前主密钥解密的密文被清空并计数，可解密的保留。
    #[test]
    fn sanitize_import_secrets_clears_foreign_ciphertext() {
        let key = crypto::derive_key("local", b"s");
        let foreign_key = crypto::derive_key("foreign", b"s");

        // 本机密文：可解密，保留
        let local_ct = crypto::encrypt(&key, "local-secret");
        // 外部密文：无法解密，清空
        let foreign_ct = crypto::encrypt(&foreign_key, "foreign-secret");
        // 明文：不受影响
        let mut input = sess("a", Some(&foreign_ct));
        input.private_key_passphrase = Some(local_ct.clone());

        let cleared = sanitize_import_secrets(&mut input, Some(&key));

        assert_eq!(cleared, 1, "仅外部密码密文被清空");
        assert!(input.password.is_none());
        // 本机私钥密码密文保留且仍可解密
        let pt = crypto::decrypt(&key, input.private_key_passphrase.as_deref().unwrap()).unwrap();
        assert_eq!(pt, "local-secret");
    }

    /// 未设置主密码（key=None）时，任何密文都无法解密，应全部清空并计数。
    #[test]
    fn sanitize_import_secrets_clears_all_without_master() {
        let foreign_key = crypto::derive_key("foreign", b"s");
        let foreign_ct = crypto::encrypt(&foreign_key, "secret");

        let mut input = sess("a", Some(&foreign_ct));
        input.private_key_passphrase = Some(foreign_ct.clone());

        let cleared = sanitize_import_secrets(&mut input, None);

        assert_eq!(cleared, 2, "无主密码时密码与私钥密码密文均被清空");
        assert!(input.password.is_none());
        assert!(input.private_key_passphrase.is_none());
    }

    /// 连接名称唯一性：同一分组（含无分组）内不允许重名，跨分组允许。
    #[test]
    fn session_name_unique_within_group() {
        let db = test_db();
        let g1 = db
            .create_group(crate::models::GroupInput { name: "测试".into(), parent_id: None })
            .unwrap();
        let g2 = db
            .create_group(crate::models::GroupInput { name: "生产".into(), parent_id: None })
            .unwrap();

        // 预置：分组 g1 下已有「web」，无分组下已有「web」
        let mut s1 = sess("web", None);
        s1.group_id = Some(g1.clone());
        let mut s2 = sess("web", None);
        s2.group_id = None;
        db.create_session(s1).unwrap();
        db.create_session(s2).unwrap();

        // 同分组 g1 内重名 → 报错
        assert!(
            ensure_session_name_unique(&db, "web", Some(&g1), None).is_err(),
            "同分组内重名应被拒绝"
        );
        // 不同分组 g2 内同名 → 允许
        assert!(
            ensure_session_name_unique(&db, "web", Some(&g2), None).is_ok(),
            "跨分组同名应被允许"
        );
        // 无分组内重名 → 报错
        assert!(
            ensure_session_name_unique(&db, "web", None, None).is_err(),
            "无分组内重名应被拒绝"
        );
        // 编辑时排除自身 → 允许（名称未变）
        let s1_id = db
            .list_sessions()
            .unwrap()
            .iter()
            .find(|s| s.group_id.as_deref() == Some(g1.as_str()))
            .unwrap()
            .id
            .clone();
        assert!(
            ensure_session_name_unique(&db, "web", Some(&g1), Some(&s1_id)).is_ok(),
            "编辑自身重名应被排除"
        );
        // 名称空白 → 报错
        assert!(ensure_session_name_unique(&db, "   ", None, None).is_err());
    }

    /// 主机密钥 TOFU 存储：写入后可读回，覆盖更新生效，不同端口互不影响。
    #[test]
    fn host_key_crud() {
        let db = test_db();
        // 未信任时返回 None
        assert_eq!(db.get_host_key("192.168.1.1", 22).unwrap(), None);
        // 首次信任
        db.set_host_key("192.168.1.1", 22, "SHA256:abc").unwrap();
        assert_eq!(
            db.get_host_key("192.168.1.1", 22).unwrap(),
            Some("SHA256:abc".to_string())
        );
        // 覆盖更新（密钥变更后重新信任）
        db.set_host_key("192.168.1.1", 22, "SHA256:def").unwrap();
        assert_eq!(
            db.get_host_key("192.168.1.1", 22).unwrap(),
            Some("SHA256:def".to_string())
        );
        // 不同端口独立
        assert_eq!(db.get_host_key("192.168.1.1", 2222).unwrap(), None);
    }

    /// 备份滚动保留：只删超出保留数的新到旧尾部
    #[test]
    fn backup_prune_keeps_newest() {
        let names: Vec<String> = (1..=12)
            .rev()
            .map(|i| format!("sessions-{i:015}-auto.json"))
            .collect();
        let stale = select_backup_prune(&names, 10);
        assert_eq!(stale.len(), 2);
        assert!(stale.contains(&"sessions-000000000000002-auto.json".to_string()));
        assert!(stale.contains(&"sessions-000000000000001-auto.json".to_string()));
        // 不足保留数时不删
        assert!(select_backup_prune(&names[..5].to_vec(), 10).is_empty());
    }

    /// 快照落盘：文件名带原因、内容可反序列化回会话，超保留数自动删除最旧。
    #[test]
    fn backup_snapshot_writes_and_prunes() {
        let dir = std::env::temp_dir().join(format!(
            "termix-backup-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let out = SessionExport {
            app: "termix".into(),
            version: 1,
            exported_at: 1,
            groups: vec![],
            sessions: vec![],
        };
        // 首份：文件名带原因，内容可读回
        let name = write_backup_snapshot(&dir, &out, "manual", 3).expect("write snapshot");
        assert!(name.starts_with("sessions-"), "unexpected name: {name}");
        assert!(name.ends_with("-manual.json"), "unexpected name: {name}");
        let raw = std::fs::read_to_string(dir.join(&name)).unwrap();
        let parsed: SessionExport = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.app, "termix");
        assert_eq!(parsed.version, 1);

        // 再写 4 份（同一毫秒可能同名，先等待确保时间戳推进）
        for i in 0..4 {
            std::thread::sleep(std::time::Duration::from_millis(3));
            write_backup_snapshot(&dir, &out, &format!("auto{i}"), 3).unwrap();
        }
        let count = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
            .count();
        assert_eq!(count, 3, "should keep only newest 3 snapshots");
        std::fs::remove_dir_all(&dir).ok();
    }
}
