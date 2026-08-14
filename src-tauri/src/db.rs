use rusqlite::{params, Connection};
use std::sync::Mutex;

use crate::models::{
    CommandHistory, ForwardRule, ForwardRuleInput, Group, GroupInput, Session, SessionInput,
    Snippet, SnippetInput,
};

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &str) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, ord INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER,
                username TEXT, auth_type TEXT, password TEXT, private_key_path TEXT,
                private_key_passphrase TEXT, group_id TEXT, memo TEXT, encoding TEXT,
                created_at INTEGER, last_connected_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS command_history (
                id TEXT PRIMARY KEY, session_id TEXT, command TEXT, executed_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS snippets (
                id TEXT PRIMARY KEY, title TEXT, command TEXT, variables TEXT,
                group_id TEXT, created_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS forward_rules (
                id TEXT PRIMARY KEY, rtype TEXT, name TEXT, local_host TEXT, local_port INTEGER,
                remote_host TEXT, remote_port INTEGER, session_id TEXT, enabled INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY, value TEXT
            );
            CREATE TABLE IF NOT EXISTS host_keys (
                host_port TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL,
                fingerprint TEXT NOT NULL, trusted_at INTEGER
            );",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list_sessions(&self) -> Result<Vec<Session>, String> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare(
                "SELECT id,name,host,port,username,auth_type,password,private_key_path,private_key_passphrase,group_id,memo,encoding,created_at,last_connected_at FROM sessions ORDER BY name",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| {
            Ok(Session {
                id: r.get(0)?,
                name: r.get(1)?,
                host: r.get(2)?,
                port: r.get(3)?,
                username: r.get(4)?,
                auth_type: r.get(5)?,
                password: r.get(6)?,
                private_key_path: r.get(7)?,
                private_key_passphrase: r.get(8)?,
                group_id: r.get(9)?,
                memo: r.get(10)?,
                encoding: r.get(11)?,
                created_at: r.get(12)?,
                last_connected_at: r.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn create_session(&self, input: SessionInput) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let encoding = input.encoding.unwrap_or_else(|| "utf-8".into());
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO sessions (id,name,host,port,username,auth_type,password,private_key_path,private_key_passphrase,group_id,memo,encoding,created_at,last_connected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
            params![
                id, input.name, input.host, input.port, input.username, input.auth_type,
                input.password, input.private_key_path, input.private_key_passphrase,
                input.group_id, input.memo, encoding, now
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn update_session(&self, id: &str, input: SessionInput) -> Result<(), String> {
        let encoding = input.encoding.unwrap_or_else(|| "utf-8".into());
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE sessions SET name=?,host=?,port=?,username=?,auth_type=?,password=?,private_key_path=?,private_key_passphrase=?,group_id=?,memo=?,encoding=? WHERE id=?",
            params![
                input.name, input.host, input.port, input.username, input.auth_type,
                input.password, input.private_key_path, input.private_key_passphrase,
                input.group_id, input.memo, encoding, id
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_session(&self, id: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM sessions WHERE id=?", params![id])
            .map_err(|e| e.to_string())?;
        c.execute("DELETE FROM command_history WHERE session_id=?", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn touch_session(&self, id: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE sessions SET last_connected_at=? WHERE id=?",
            params![now_ms(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_groups(&self) -> Result<Vec<Group>, String> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare("SELECT id,name,parent_id,ord FROM groups ORDER BY ord,name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Group {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    parent_id: r.get(2)?,
                    ord: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn create_group(&self, input: GroupInput) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO groups (id,name,parent_id,ord) VALUES (?,?,?,0)",
            params![id, input.name, input.parent_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn delete_group(&self, id: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM groups WHERE id=?", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_history(&self, session_id: &str, limit: u32) -> Result<Vec<CommandHistory>, String> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare(
                "SELECT id,session_id,command,executed_at FROM command_history WHERE session_id=? ORDER BY executed_at DESC LIMIT ?",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![session_id, limit], |r| {
                Ok(CommandHistory {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    command: r.get(2)?,
                    executed_at: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn add_history(&self, session_id: &str, command: &str) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO command_history (id,session_id,command,executed_at) VALUES (?,?,?,?)",
            params![id, session_id, command, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn clear_history(&self, session_id: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "DELETE FROM command_history WHERE session_id=?",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---- v0.3: 命令片段 ----

    pub fn list_snippets(&self) -> Result<Vec<Snippet>, String> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare("SELECT id,title,command,variables,group_id,created_at FROM snippets ORDER BY created_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Snippet {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    command: r.get(2)?,
                    variables: r.get(3)?,
                    group_id: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn create_snippet(&self, input: SnippetInput) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let variables = input.variables.unwrap_or_else(|| "[]".into());
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO snippets (id,title,command,variables,group_id,created_at) VALUES (?,?,?,?,?,?)",
            params![id, input.title, input.command, variables, input.group_id, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn update_snippet(&self, id: &str, input: SnippetInput) -> Result<(), String> {
        let variables = input.variables.unwrap_or_else(|| "[]".into());
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE snippets SET title=?,command=?,variables=?,group_id=? WHERE id=?",
            params![input.title, input.command, variables, input.group_id, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_snippet(&self, id: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM snippets WHERE id=?", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---- v0.3: 端口转发规则 ----

    pub fn list_forwards(&self) -> Result<Vec<ForwardRule>, String> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare(
                "SELECT id,rtype,name,local_host,local_port,remote_host,remote_port,session_id,enabled FROM forward_rules ORDER BY name",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ForwardRule {
                    id: r.get(0)?,
                    rtype: r.get(1)?,
                    name: r.get(2)?,
                    local_host: r.get(3)?,
                    local_port: r.get(4)?,
                    remote_host: r.get(5)?,
                    remote_port: r.get(6)?,
                    session_id: r.get(7)?,
                    enabled: r.get::<_, i64>(8)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn create_forward(&self, input: ForwardRuleInput) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let local_host = input.local_host.unwrap_or_else(|| "127.0.0.1".into());
        let remote_host = input.remote_host.unwrap_or_default();
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO forward_rules (id,rtype,name,local_host,local_port,remote_host,remote_port,session_id,enabled) VALUES (?,?,?,?,?,?,?,?,0)",
            params![id, input.rtype, input.name, local_host, input.local_port, remote_host, input.remote_port, input.session_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn update_forward(&self, id: &str, input: ForwardRuleInput) -> Result<(), String> {
        let local_host = input.local_host.unwrap_or_else(|| "127.0.0.1".into());
        let remote_host = input.remote_host.unwrap_or_default();
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE forward_rules SET rtype=?,name=?,local_host=?,local_port=?,remote_host=?,remote_port=?,session_id=? WHERE id=?",
            params![input.rtype, input.name, local_host, input.local_port, remote_host, input.remote_port, input.session_id, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_forward(&self, id: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM forward_rules WHERE id=?", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_forward_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE forward_rules SET enabled=? WHERE id=?",
            params![if enabled { 1 } else { 0 }, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---- 应用级设置（主密码盐/校验等） ----

    pub fn get_setting(&self, key: &str) -> Option<String> {
        let c = self.conn.lock().unwrap();
        c.query_row("SELECT value FROM app_settings WHERE key=?", params![key], |r| {
            r.get(0)
        })
        .ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_setting(&self, key: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM app_settings WHERE key=?", params![key])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---- 主机密钥（TOFU：首次信任后校验指纹） ----

    /// 查询已信任的主机密钥指纹；未信任返回 None。
    pub fn get_host_key(&self, host: &str, port: u16) -> Result<Option<String>, String> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT fingerprint FROM host_keys WHERE host=? AND port=?",
            params![host, port],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            _ => Err(e.to_string()),
        })
    }

    /// 记录信任的主机密钥指纹（首次连接确认后写入）。
    pub fn set_host_key(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        c.execute(
            "INSERT INTO host_keys (host_port,host,port,fingerprint,trusted_at)
             VALUES (?,?,?,?,?)
             ON CONFLICT(host_port) DO UPDATE SET fingerprint=excluded.fingerprint, trusted_at=excluded.trusted_at",
            params![format!("{host}:{port}"), host, port, fingerprint, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Db {
        Db::open(":memory:").unwrap()
    }

    fn session_input(name: &str) -> SessionInput {
        SessionInput {
            name: name.into(),
            host: "192.168.1.10".into(),
            port: 22,
            username: "root".into(),
            auth_type: "password".into(),
            password: Some("secret".into()),
            private_key_path: None,
            private_key_passphrase: None,
            group_id: None,
            memo: None,
            encoding: None,
        }
    }

    #[test]
    fn session_crud_roundtrip() {
        let db = test_db();
        assert!(db.list_sessions().unwrap().is_empty());

        let id = db.create_session(session_input("prod")).unwrap();
        let list = db.list_sessions().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "prod");
        assert_eq!(list[0].host, "192.168.1.10");
        assert_eq!(list[0].port, 22);
        assert_eq!(list[0].encoding, "utf-8");
        assert!(list[0].last_connected_at.is_none());

        // update
        let mut input = session_input("prod-renamed");
        input.encoding = Some("gbk".into());
        db.update_session(&id, input).unwrap();
        let list = db.list_sessions().unwrap();
        assert_eq!(list[0].name, "prod-renamed");
        assert_eq!(list[0].encoding, "gbk");

        // touch
        db.touch_session(&id).unwrap();
        assert!(db.list_sessions().unwrap()[0].last_connected_at.is_some());

        // delete
        db.delete_session(&id).unwrap();
        assert!(db.list_sessions().unwrap().is_empty());
    }

    #[test]
    fn group_crud() {
        let db = test_db();
        let id = db.create_group(GroupInput { name: "生产".into(), parent_id: None }).unwrap();
        let groups = db.list_groups().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "生产");
        assert!(groups[0].parent_id.is_none());
        assert_eq!(groups[0].ord, 0);

        db.delete_group(&id).unwrap();
        assert!(db.list_groups().unwrap().is_empty());
    }

    #[test]
    fn history_add_list_clear() {
        let db = test_db();
        let sid = db.create_session(session_input("h")).unwrap();

        db.add_history(&sid, "ls -la").unwrap();
        db.add_history(&sid, "df -h").unwrap();
        db.add_history(&sid, "free -m").unwrap();

        let all = db.list_history(&sid, 50).unwrap();
        assert_eq!(all.len(), 3);
        // 毫秒级时间戳下同批插入可能执行时间相同，因此只校验内容集合
        let mut cmds: Vec<&str> = all.iter().map(|h| h.command.as_str()).collect();
        cmds.sort();
        assert_eq!(cmds, vec!["df -h", "free -m", "ls -la"]);

        // limit 生效
        let two = db.list_history(&sid, 2).unwrap();
        assert_eq!(two.len(), 2);

        // 其他会话的历史不影响
        let other = db.create_session(session_input("other")).unwrap();
        assert!(db.list_history(&other, 50).unwrap().is_empty());

        db.clear_history(&sid).unwrap();
        assert!(db.list_history(&sid, 50).unwrap().is_empty());
    }

    #[test]
    fn delete_session_cascades_history() {
        let db = test_db();
        let sid = db.create_session(session_input("h")).unwrap();
        db.add_history(&sid, "top").unwrap();
        db.delete_session(&sid).unwrap();
        assert!(db.list_history(&sid, 50).unwrap().is_empty());
    }

    #[test]
    fn snippet_crud() {
        let db = test_db();
        let id = db
            .create_snippet(SnippetInput {
                title: "重启服务".into(),
                command: "sudo systemctl restart nginx".into(),
                variables: None,
                group_id: None,
            })
            .unwrap();
        let list = db.list_snippets().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "重启服务");
        // variables 默认存 "[]"
        assert_eq!(list[0].variables, "[]");

        db.update_snippet(
            &id,
            SnippetInput {
                title: "重启服务v2".into(),
                command: "sudo systemctl restart nginx && echo done".into(),
                variables: Some("[{\"k\":\"port\",\"v\":\"8080\"}]".into()),
                group_id: None,
            },
        )
        .unwrap();
        let list = db.list_snippets().unwrap();
        assert_eq!(list[0].title, "重启服务v2");
        assert!(list[0].variables.contains("8080"));

        db.delete_snippet(&id).unwrap();
        assert!(db.list_snippets().unwrap().is_empty());
    }

    #[test]
    fn forward_crud_and_enabled() {
        let db = test_db();
        let id = db
            .create_forward(ForwardRuleInput {
                rtype: "local".into(),
                name: "pg 转发".into(),
                local_host: None,
                local_port: 5432,
                remote_host: Some("db.internal".into()),
                remote_port: 5432,
                session_id: None,
            })
            .unwrap();
        let list = db.list_forwards().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "pg 转发");
        // 默认 host 与 enabled
        assert_eq!(list[0].local_host, "127.0.0.1");
        assert!(!list[0].enabled);

        db.set_forward_enabled(&id, true).unwrap();
        assert!(db.list_forwards().unwrap()[0].enabled);

        db.set_forward_enabled(&id, false).unwrap();
        assert!(!db.list_forwards().unwrap()[0].enabled);

        db.delete_forward(&id).unwrap();
        assert!(db.list_forwards().unwrap().is_empty());
    }
}
