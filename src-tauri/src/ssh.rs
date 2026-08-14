use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{Channel, ChannelOpenFailure, ChannelMsg, Disconnect};
use tauri::{AppHandle, Emitter};
use tokio::io::copy_bidirectional;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};

use crate::models::Session;

/// 远程端口转发注册表：服务端监听端口 → 本地目标 (host, port)。
/// handler 收到 forwarded-tcpip 连接时按监听端口查表转发到本地。
pub struct ForwardRegistry {
    targets: std::sync::Mutex<HashMap<u32, (String, u16)>>,
}

impl ForwardRegistry {
    pub fn new() -> Self {
        Self {
            targets: std::sync::Mutex::new(HashMap::new()),
        }
    }
    pub fn register(&self, bind_port: u32, host: &str, port: u16) {
        log::info!("remote-forward: register bind port {bind_port} -> {host}:{port}");
        self.targets.lock().unwrap().insert(bind_port, (host.to_string(), port));
    }
    pub fn unregister(&self, bind_port: u32) {
        log::info!("remote-forward: unregister bind port {bind_port}");
        self.targets.lock().unwrap().remove(&bind_port);
    }
    pub fn target(&self, bind_port: u32) -> Option<(String, u16)> {
        self.targets.lock().unwrap().get(&bind_port).cloned()
    }
}

/// 主机密钥校验结果（TOFU：首次信任、后续校验，变更则拒绝）。
#[derive(Debug, Clone)]
pub enum HostKeyStatus {
    /// 首次连接，主机密钥尚未信任（需用户确认后重连）。
    Unverified { fingerprint: String },
    /// 主机密钥与已信任记录不一致（可能中间人攻击）。
    Mismatch { fingerprint: String, expected: String },
}

/// SshClient 持有已知指纹与校验结果，`check_server_key` 据此决定是否接受连接。
pub struct SshClient {
    forwards: Arc<ForwardRegistry>,
    known_fingerprint: Option<String>,
    pending: Arc<Mutex<Option<HostKeyStatus>>>,
}

impl SshClient {
    fn new(
        forwards: Arc<ForwardRegistry>,
        known_fingerprint: Option<String>,
        pending: Arc<Mutex<Option<HostKeyStatus>>>,
    ) -> Self {
        Self {
            forwards,
            known_fingerprint,
            pending,
        }
    }
}

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = ssh_key::Fingerprint::new(
            ssh_key::HashAlg::Sha256,
            server_public_key.key_data(),
        )
        .to_string();
        match &self.known_fingerprint {
            Some(expected) if expected == &fingerprint => {
                log::debug!("host key verified: {fingerprint}");
                Ok(true)
            }
            Some(expected) => {
                log::warn!(
                    "host key MISMATCH! got {fingerprint}, expected {expected}"
                );
                *self.pending.lock().await = Some(HostKeyStatus::Mismatch {
                    fingerprint,
                    expected: expected.clone(),
                });
                Ok(false)
            }
            None => {
                log::info!("host key unverified (first connect): {fingerprint}");
                *self.pending.lock().await = Some(HostKeyStatus::Unverified { fingerprint });
                Ok(false)
            }
        }
    }

    /// 服务端推送的远程转发连接：按监听端口查表，连本地目标后双向转发。
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        log::debug!(
            "remote-forward: server opened forwarded-tcpip {}:{}",
            connected_address,
            connected_port
        );
        let target = self.forwards.target(connected_port);
        tokio::spawn(async move {
            let Some((host, port)) = target else {
                log::warn!("remote-forward: no local target for bind port {connected_port}, reject");
                let _ = reply.reject(ChannelOpenFailure::ConnectFailed).await;
                return;
            };
            let addr = format!("{host}:{port}");
            let mut local = match TcpStream::connect(&addr).await {
                Ok(s) => s,
                Err(e) => {
                    log::error!("remote-forward: connect local {addr} failed: {e}");
                    let _ = reply.reject(ChannelOpenFailure::ConnectFailed).await;
                    return;
                }
            };
            reply.accept().await;
            log::debug!("remote-forward: tunnel established to local {addr}");
            let mut stream = channel.into_stream();
            match copy_bidirectional(&mut local, &mut stream).await {
                Ok(_) => log::debug!("remote-forward: tunnel to {addr} closed"),
                Err(e) => log::debug!("remote-forward: tunnel to {addr} error: {e}"),
            }
        });
        Ok(())
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
    forwards: Arc<ForwardRegistry>,
    /// 最近一次 connect 的主机密钥校验结果（连接失败时由调用方读取）。
    pending_key: std::sync::Mutex<Option<Arc<Mutex<Option<HostKeyStatus>>>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            forwards: Arc::new(ForwardRegistry::new()),
            pending_key: std::sync::Mutex::new(None),
        }
    }

    pub async fn connect(
        &self,
        s: Session,
        known_fingerprint: Option<String>,
    ) -> Result<String, String> {
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(30)),
            // SSH 心跳保活：30s 无数据则发送 keepalive，连续 3 次无响应才断开
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            ..<_>::default()
        });
        let addr = format!("{}:{}", s.host, s.port);
        let pending = Arc::new(Mutex::new(None));
        *self.pending_key.lock().unwrap() = Some(pending.clone());
        let mut session = client::connect(
            config,
            addr.as_str(),
            SshClient::new(self.forwards.clone(), known_fingerprint, pending),
        )
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
        // 连接成功：清除未决的主机密钥校验状态
        *self.pending_key.lock().unwrap() = None;
        Ok(connection_id)
    }

    /// 取走最近一次 connect 的主机密钥校验结果（用于连接失败时区分
    /// 未信任 / 密钥变更），取走后自动清空。
    pub async fn take_pending_key(&self) -> Option<HostKeyStatus> {
        let arc = self.pending_key.lock().unwrap().take();
        match arc {
            Some(a) => a.lock().await.take(),
            None => None,
        }
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

    // ---- 远程端口转发 ----

    /// 注册远程转发目标（bind_port = 服务端监听端口）。
    pub fn register_remote_forward(&self, bind_port: u32, host: &str, port: u16) {
        self.forwards.register(bind_port, host, port);
    }

    pub fn unregister_remote_forward(&self, bind_port: u32) {
        self.forwards.unregister(bind_port);
    }

    /// 请求服务端开启远程端口转发，返回实际绑定的端口。
    pub async fn request_remote_forward(
        &self,
        connection_id: &str,
        bind_host: &str,
        bind_port: u32,
    ) -> Result<u32, String> {
        let handle = self
            .get_handle(connection_id)
            .await
            .ok_or_else(|| "connection not found".to_string())?;
        log::info!(
            "remote-forward: request server to bind {bind_host}:{bind_port} on connection {connection_id}"
        );
        handle
            .tcpip_forward(bind_host, bind_port)
            .await
            .map_err(|e| {
                log::error!("remote-forward: tcpip-forward request failed: {e}");
                format!("服务端开启远程转发失败: {e}")
            })
    }

    /// 取消服务端远程端口转发。
    pub async fn cancel_remote_forward(
        &self,
        connection_id: &str,
        bind_host: &str,
        bind_port: u32,
    ) -> Result<(), String> {
        let handle = self
            .get_handle(connection_id)
            .await
            .ok_or_else(|| "connection not found".to_string())?;
        log::info!("remote-forward: cancel server bind {bind_host}:{bind_port}");
        handle
            .cancel_tcpip_forward(bind_host, bind_port)
            .await
            .map_err(|e| format!("取消远程转发失败: {e}"))
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
            let mut user_closed = false;
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
                            user_closed = true;
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
            // 兜底：被动断开（网络中断等）时确保通知前端，便于自动重连
            if !user_closed {
                let _ = app2.emit(
                    "connection-status",
                    serde_json::json!({ "shellId": sid, "tabId": tab_id, "status": "closed" }),
                );
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
