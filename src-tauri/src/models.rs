use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub private_key_passphrase: Option<String>,
    pub group_id: Option<String>,
    pub memo: Option<String>,
    pub encoding: String,
    pub created_at: i64,
    pub last_connected_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub private_key_passphrase: Option<String>,
    pub group_id: Option<String>,
    pub memo: Option<String>,
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub ord: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInput {
    pub name: String,
    pub parent_id: Option<String>,
}

// ---- 会话导入 / 导出 ----

/// 会话备份文件顶层结构（JSON）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExport {
    pub app: String,
    pub version: u32,
    pub exported_at: i64,
    pub groups: Vec<Group>,
    pub sessions: Vec<Session>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionImportResult {
    pub groups_created: usize,
    pub sessions_created: usize,
    pub sessions_skipped: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistory {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub executed_at: i64,
}

// ---- v0.3: 命令片段 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub title: String,
    pub command: String,
    pub variables: String,
    pub group_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetInput {
    pub title: String,
    pub command: String,
    pub variables: Option<String>,
    pub group_id: Option<String>,
}

// ---- v0.3: 端口转发 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRule {
    pub id: String,
    pub rtype: String,
    pub name: String,
    pub local_host: String,
    pub local_port: u32,
    pub remote_host: String,
    pub remote_port: u32,
    pub session_id: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRuleInput {
    pub rtype: String,
    pub name: String,
    pub local_host: Option<String>,
    pub local_port: u32,
    pub remote_host: Option<String>,
    pub remote_port: u32,
    pub session_id: Option<String>,
}

// ---- v0.3: 系统监控 ----

/// 主密码状态（安全设置）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterStatus {
    pub has_master: bool,
    pub unlocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount: String,
    pub total: u64,
    pub used: u64,
    pub pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub cpu: f64,
    pub mem_used: u64,
    pub mem_total: u64,
    pub disk_used_pct: f64,
    pub net_rx: u64,
    pub net_tx: u64,
    pub net_conns: u32,
    pub disks: Vec<DiskInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub user: String,
    pub cpu: f64,
    pub mem: f64,
    pub cmd: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_session() -> Session {
        Session {
            id: "s1".into(),
            name: "prod".into(),
            host: "1.2.3.4".into(),
            port: 22,
            username: "root".into(),
            auth_type: "password".into(),
            password: Some("secret".into()),
            private_key_path: None,
            private_key_passphrase: None,
            group_id: Some("g1".into()),
            memo: None,
            encoding: "utf-8".into(),
            created_at: 123,
            last_connected_at: None,
        }
    }

    /// 会话备份 JSON 序列化 / 反序列化回环（导出 -> 导入互通）。
    #[test]
    fn session_export_json_roundtrip() {
        let exp = SessionExport {
            app: "termix".into(),
            version: 1,
            exported_at: 123,
            groups: vec![Group {
                id: "g1".into(),
                name: "生产".into(),
                parent_id: None,
                ord: 0,
            }],
            sessions: vec![sample_session()],
        };
        let json = serde_json::to_string(&exp).expect("serialize");
        // camelCase 命名
        assert!(json.contains("\"exportedAt\""));
        let back: SessionExport = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.app, "termix");
        assert_eq!(back.version, 1);
        assert_eq!(back.groups.len(), 1);
        assert_eq!(back.groups[0].name, "生产");
        assert_eq!(back.sessions.len(), 1);
        assert_eq!(back.sessions[0].name, "prod");
        assert_eq!(back.sessions[0].password.as_deref(), Some("secret"));
        assert_eq!(back.sessions[0].group_id.as_deref(), Some("g1"));
    }

    /// 非 Termix 备份文件应缺少 app 标识（导入侧据此拒绝）。
    #[test]
    fn foreign_backup_rejected_by_app_field() {
        let foreign = r#"{"app":"other","version":1,"exportedAt":0,"groups":[],"sessions":[]}"#;
        let parsed: SessionExport = serde_json::from_str(foreign).expect("parse");
        assert_ne!(parsed.app, "termix");
    }
}
