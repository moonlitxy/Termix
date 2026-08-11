use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

use crate::models::Session;

/// Accept any host key. (MVP: TODO: known_hosts verification)
pub struct SshClient;

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub enum ShellCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct Connection {
    handle: Arc<client::Handle<SshClient>>,
    shells: Arc<Mutex<HashMap<String, mpsc::Sender<ShellCmd>>>>,
}

pub struct SshManager {
    connections: Mutex<HashMap<String, Connection>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connect(&self, s: Session) -> Result<String, String> {
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..<_>::default()
        });
        let addr = format!("{}:{}", s.host, s.port);
        let mut session = client::connect(config, addr.as_str(), SshClient)
            .await
            .map_err(|e| format!("connect failed: {e}"))?;

        let ok = match s.auth_type.as_str() {
            "key" => {
                let path = s
                    .private_key_path
                    .as_deref()
                    .ok_or_else(|| "no private key path".to_string())?;
                let key = load_secret_key(path, s.private_key_passphrase.as_deref())
                    .map_err(|e| format!("load key failed: {e}"))?;
                session
                    .authenticate_publickey(
                        &s.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), None),
                    )
                    .await
                    .map_err(|e| format!("auth failed: {e}"))?
                    .success()
            }
            _ => {
                let pwd = s.password.clone().unwrap_or_default();
                session
                    .authenticate_password(&s.username, &pwd)
                    .await
                    .map_err(|e| format!("auth failed: {e}"))?
                    .success()
            }
        };

        if !ok {
            return Err("authentication failed".into());
        }

        let connection_id = uuid::Uuid::new_v4().to_string();
        let conn = Connection {
            handle: Arc::new(session),
            shells: Arc::new(Mutex::new(HashMap::new())),
        };
        self.connections
            .lock()
            .await
            .insert(connection_id.clone(), conn);
        Ok(connection_id)
    }

    pub async fn disconnect(&self, connection_id: &str) -> Result<(), String> {
        let conn = self.connections.lock().await.remove(connection_id);
        if let Some(conn) = conn {
            {
                let shells = conn.shells.lock().await;
                for (_, tx) in shells.iter() {
                    let _ = tx.try_send(ShellCmd::Close);
                }
            }
            let _ = conn
                .handle
                .disconnect(Disconnect::ByApplication, "", "English")
                .await;
        }
        Ok(())
    }

    pub async fn get_handle(&self, connection_id: &str) -> Option<Arc<client::Handle<SshClient>>> {
        let cons = self.connections.lock().await;
        cons.get(connection_id).map(|c| c.handle.clone())
    }

    /// 在连接上执行一次性命令并返回完整输出（用于监控等）。
    pub async fn exec_command(&self, connection_id: &str, command: &str) -> Result<String, String> {
        let handle = self
            .get_handle(connection_id)
            .await
            .ok_or_else(|| "connection not found".to_string())?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("open channel failed: {e}"))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("exec failed: {e}"))?;
        let mut output = String::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    output.push_str(&String::from_utf8_lossy(&data));
                }
                ChannelMsg::ExitStatus { .. } | ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(output)
    }

    pub async fn terminal_create(
        &self,
        app: AppHandle,
        connection_id: &str,
        tab_id: String,
        cols: u32,
        rows: u32,
    ) -> Result<String, String> {
        let (mut channel, shells) = {
            let mut cons = self.connections.lock().await;
            let conn = cons
                .get_mut(connection_id)
                .ok_or_else(|| "connection not found".to_string())?;
            let channel = conn
                .handle
                .channel_open_session()
                .await
                .map_err(|e| e.to_string())?;
            channel
                .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
                .await
                .map_err(|e| e.to_string())?;
            channel
                .request_shell(true)
                .await
                .map_err(|e| e.to_string())?;
            (channel, conn.shells.clone())
        };

        let shell_id = uuid::Uuid::new_v4().to_string();
        let (tx, mut rx) = mpsc::channel::<ShellCmd>(64);
        let sid = shell_id.clone();
        let app2 = app.clone();
        let shells2 = shells.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    cmd = rx.recv() => match cmd {
                        Some(ShellCmd::Data(d)) => {
                            if channel.data(d.as_slice()).await.is_err() { break; }
                        }
                        Some(ShellCmd::Resize(c, r)) => {
                            let _ = channel.window_change(c, r, 0, 0).await;
                        }
                        Some(ShellCmd::Close) | None => {
                            let _ = channel.close().await;
                            break;
                        }
                    },
                    msg = channel.wait() => match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let text = String::from_utf8_lossy(&data).into_owned();
                            let _ = app2.emit(
                                "terminal-output",
                                serde_json::json!({ "shellId": sid, "data": text, "tabId": tab_id }),
                            );
                        }
                        Some(ChannelMsg::ExitStatus { .. })
                        | Some(ChannelMsg::Eof)
                        | Some(ChannelMsg::Close) => {
                            let _ = app2.emit(
                                "connection-status",
                                serde_json::json!({ "shellId": sid, "tabId": tab_id, "status": "closed" }),
                            );
                            break;
                        }
                        None => break,
                        _ => {}
                    },
                }
            }
            shells2.lock().await.remove(&sid);
        });

        shells.lock().await.insert(shell_id.clone(), tx);
        Ok(shell_id)
    }

    pub async fn terminal_write(
        &self,
        connection_id: &str,
        shell_id: &str,
        data: Vec<u8>,
    ) -> Result<(), String> {
        let tx = {
            let cons = self.connections.lock().await;
            let conn = cons
                .get(connection_id)
                .ok_or_else(|| "connection not found".to_string())?;
            let shells = conn.shells.lock().await;
            shells.get(shell_id).cloned()
        };
        if let Some(tx) = tx {
            tx.send(ShellCmd::Data(data))
                .await
                .map_err(|_| "shell closed".to_string())?;
            Ok(())
        } else {
            Err("shell not found".into())
        }
    }

    pub async fn terminal_resize(
        &self,
        connection_id: &str,
        shell_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(), String> {
        let tx = {
            let cons = self.connections.lock().await;
            let conn = cons
                .get(connection_id)
                .ok_or_else(|| "connection not found".to_string())?;
            let shells = conn.shells.lock().await;
            shells.get(shell_id).cloned()
        };
        if let Some(tx) = tx {
            let _ = tx.send(ShellCmd::Resize(cols, rows)).await;
        }
        Ok(())
    }

    pub async fn terminal_destroy(
        &self,
        connection_id: &str,
        shell_id: &str,
    ) -> Result<(), String> {
        let tx = {
            let cons = self.connections.lock().await;
            let conn = cons
                .get(connection_id)
                .ok_or_else(|| "connection not found".to_string())?;
            let mut shells = conn.shells.lock().await;
            shells.remove(shell_id)
        };
        if let Some(tx) = tx {
            let _ = tx.send(ShellCmd::Close).await;
        }
        Ok(())
    }
}
