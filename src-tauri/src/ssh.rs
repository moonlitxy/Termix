use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use russh::client;
use russh::keys::{load_secret_key, Algorithm, HashAlg, PrivateKeyWithHashAlg};
use russh::{Channel, ChannelOpenFailure, ChannelMsg, Disconnect};
use tauri::{AppHandle, Emitter};
use tokio::io::copy_bidirectional;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};

use crate::models::Session;

/// 键盘交互认证（2FA/挑战应答）的前端提示项
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptItem {
    pub text: String,
    pub echo: bool,
}

/// 推送给前端的认证提示事件（`auth-prompt`）：用户填写后调 `auth_respond` 回填
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptEvent {
    pub auth_id: String,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<AuthPromptItem>,
}

/// 键盘交互认证单次等待前端输入的超时（秒）：2FA 用户需要找手机的时间
const AUTH_PROMPT_TIMEOUT_SECS: u64 = 120;

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
    /// 连接终止时据此从 SshManager 移除自身：
    /// 若不清理，残留连接会让 shell channel 挂起、前端收不到断开事件、
    /// 监控轮询持续对死连接失败。
    connections: Arc<Mutex<HashMap<String, Connection>>>,
    conn_id: String,
    /// 是否为本连接中转远端 agent 通道到本地（ssh -A 等价能力）。
    /// 关闭时服务端打开的 agent 通道直接拒绝，不触碰本地 Agent。
    agent_relay: bool,
}

impl SshClient {
    fn new(
        forwards: Arc<ForwardRegistry>,
        known_fingerprint: Option<String>,
        pending: Arc<Mutex<Option<HostKeyStatus>>>,
        connections: Arc<Mutex<HashMap<String, Connection>>>,
        conn_id: String,
        agent_relay: bool,
    ) -> Self {
        Self {
            forwards,
            known_fingerprint,
            pending,
            connections,
            conn_id,
            agent_relay,
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

    /// 连接终止（正常/异常/超时）时移除残留连接，让 shell task 退出并通知前端。
    fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        async move {
            log::warn!("ssh: connection {} disconnected: {reason:?}", self.conn_id);
            self.connections.lock().await.remove(&self.conn_id);
            Ok(())
        }
    }

    /// 服务端打开 agent 转发通道（`ssh -A` 对端行为）：
    /// 接受后把通道字节流与本地 SSH Agent 套接字双向中转。
    /// 未启用 agent 转发时直接拒绝（reply 丢弃即拒绝）。
    fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<client::Msg>,
        _reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let enabled = self.agent_relay;
        let conn_id = self.conn_id.clone();
        async move {
            if !enabled {
                log::debug!("ssh: agent-forward channel rejected (not enabled) conn={conn_id}");
                return Ok(());
            }
            #[cfg(not(unix))]
            {
                log::warn!("ssh: agent relay unsupported on this platform conn={conn_id}");
                return Ok(());
            }
            #[cfg(unix)]
            {
                use tokio::net::UnixStream;
                let sock = match std::env::var("SSH_AUTH_SOCK") {
                    Ok(s) if !s.is_empty() => s,
                    _ => {
                        log::warn!("ssh: SSH_AUTH_SOCK not set, reject agent channel conn={conn_id}");
                        return Ok(());
                    }
                };
                tokio::spawn(async move {
                    _reply.accept().await;
                    let mut local = match UnixStream::connect(&sock).await {
                        Ok(s) => s,
                        Err(e) => {
                            log::warn!("ssh: connect local agent {sock} failed: {e}");
                            return;
                        }
                    };
                    let mut stream = channel.into_stream();
                    match copy_bidirectional(&mut local, &mut stream).await {
                        Ok(_) => log::debug!("ssh: agent relay closed conn={conn_id}"),
                        Err(e) => log::debug!("ssh: agent relay error conn={conn_id}: {e}"),
                    }
                });
                Ok(())
            }
        }
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
    encoding: &'static encoding_rs::Encoding,
    /// 本连接启用的 agent 转发：新开 shell 通道时自动发送 auth-agent-req
    agent_forward: bool,
    /// 经跳板建立的连接：持有的跳板连接 id，随目标一起清理
    jump_connection_id: Option<String>,
}

fn resolve_encoding(name: &str) -> &'static encoding_rs::Encoding {
    encoding_rs::Encoding::for_label(name.as_bytes())
        .unwrap_or(encoding_rs::UTF_8)
}

fn decode_remote_bytes(data: &[u8], encoding: &'static encoding_rs::Encoding) -> String {
    if encoding == encoding_rs::UTF_8 {
        return String::from_utf8_lossy(data).into_owned();
    }
    let (text, _, had_errors) = encoding.decode(data);
    if had_errors {
        log::debug!("ssh: decode with {} fallback replaced invalid bytes", encoding.name());
    }
    text.into_owned()
}

fn encode_terminal_input(
    text: &str,
    encoding: &'static encoding_rs::Encoding,
) -> Result<Vec<u8>, String> {
    if encoding == encoding_rs::UTF_8 {
        return Ok(text.as_bytes().to_vec());
    }
    let (bytes, _, had_errors) = encoding.encode(text);
    if had_errors {
        return Err(format!("encode input with {} failed", encoding.name()));
    }
    Ok(bytes.to_vec())
}

pub struct SshManager {
    connections: Arc<Mutex<HashMap<String, Connection>>>,
    forwards: Arc<ForwardRegistry>,
    /// Tauri 应用句柄：键盘交互认证时向前端推送 `auth-prompt` 事件。
    /// setup 阶段注入（`set_app_handle`），缺失时 2FA 连接直接报错。
    app: std::sync::OnceLock<AppHandle>,
    /// 等待前端回填的认证输入：auth_id → 一次性应答通道
    pending_auth: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<Vec<String>>>>>,
}

/// 跳板目标：复用另一已保存会话先连跳板机，再经 direct-tcpip 到目标。
pub struct JumpTarget {
    pub session: Session,
    pub known_fingerprint: Option<String>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(Mutex::new(HashMap::new())),
            forwards: Arc::new(ForwardRegistry::new()),
            app: std::sync::OnceLock::new(),
            pending_auth: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 注入 Tauri 应用句柄（main setup 阶段调用一次）。
    pub fn set_app_handle(&self, handle: AppHandle) {
        let _ = self.app.set(handle);
    }

    /// 前端回填键盘交互认证的应答（`auth_respond` 命令入口）。
    pub async fn auth_respond(&self, auth_id: &str, responses: Vec<String>) -> Result<(), String> {
        let tx = self
            .pending_auth
            .lock()
            .await
            .remove(auth_id)
            .ok_or_else(|| "认证请求已过期或不存在".to_string())?;
        tx.send(responses)
            .map_err(|_| "认证应答投递失败".to_string())
    }

    /// 前端取消键盘交互认证（`auth_cancel` 命令入口）。
    pub async fn auth_cancel(&self, auth_id: &str) -> Result<(), String> {
        if self.pending_auth.lock().await.remove(auth_id).is_some() {
            Ok(())
        } else {
            Err("认证请求已过期或不存在".to_string())
        }
    }

    /// 等待前端回填一次键盘交互应答；超时/取消/缺句柄均返回错误。
    async fn wait_auth_responses(
        &self,
        auth_id: &str,
        name: &str,
        instructions: &str,
        prompts: &[(String, bool)],
    ) -> Result<Vec<String>, String> {
        let app = self
            .app
            .get()
            .ok_or_else(|| "认证服务未就绪（缺少应用句柄）".to_string())?
            .clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending_auth
            .lock()
            .await
            .insert(auth_id.to_string(), tx);
        app.emit(
            "auth-prompt",
            AuthPromptEvent {
                auth_id: auth_id.to_string(),
                name: name.to_string(),
                instructions: instructions.to_string(),
                prompts: prompts
                    .iter()
                    .map(|(text, echo)| AuthPromptItem {
                        text: text.clone(),
                        echo: *echo,
                    })
                    .collect(),
            },
        )
        .map_err(|e| format!("推送认证提示失败：{e}"))?;
        match tokio::time::timeout(Duration::from_secs(AUTH_PROMPT_TIMEOUT_SECS), rx).await {
            Ok(Ok(responses)) => Ok(responses),
            // 发送端被 auth_cancel 移除后丢弃：视为用户取消
            Ok(Err(_)) | Err(_) => {
                self.pending_auth.lock().await.remove(auth_id);
                Err("已取消验证（或等待输入超时）".to_string())
            }
        }
    }

    pub async fn connect(
        &self,
        s: Session,
        jump: Option<JumpTarget>,
        known_fingerprint: Option<String>,
        // 每次连接的独立校验结果容器：由调用方创建并持有，
        // 并发连接时互不覆盖，失败后调用方据此区分「未信任/密钥变更」。
        pending: Arc<Mutex<Option<HostKeyStatus>>>,
    ) -> Result<String, String> {
        let config = Arc::new(client::Config {
            // 注意：inactivity_timeout 必须禁用或远大于 keepalive_interval。
            // russh 主循环中发送 keepalive 的分支不会重置 inactivity 定时器，
            // 两者取相同值会导致连接在首次保活后被 inactivity 立即断开。
            // 死连接检测交给 keepalive（30s 一次，3 次无响应断开）。
            inactivity_timeout: None,
            // SSH 心跳保活：30s 无数据则发送 keepalive@openssh.com，连续 3 次无响应才断开
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            ..<_>::default()
        });
        let addr = format!("{}:{}", s.host, s.port);
        // 提前生成连接 id：SshClient 持之用于断线时从 connections 中移除自身
        let connection_id = uuid::Uuid::new_v4().to_string();
        // 直连或经跳板建立底层 SSH 会话
        let (mut session, jump_connection_id) = match jump {
            None => {
                let session = client::connect(
                    config.clone(),
                    addr.as_str(),
                    SshClient::new(
                        self.forwards.clone(),
                        known_fingerprint,
                        pending.clone(),
                        self.connections.clone(),
                        connection_id.clone(),
                        s.agent_forward,
                    ),
                )
                .await
                .map_err(|e| format!("connect failed: {e}"))?;
                (session, None)
            }
            Some(jump_target) => {
                let (session, jump_conn_id) = self
                    .connect_via_jump(
                        &jump_target,
                        &s,
                        config.clone(),
                        pending.clone(),
                        connection_id.clone(),
                        known_fingerprint.clone(),
                    )
                    .await?;
                (session, Some(jump_conn_id))
            }
        };

        let ok = self.authenticate(&mut session, &s, &connection_id).await?;

        if !ok {
            return Err("authentication failed".into());
        }

        let conn = Connection {
            handle: Arc::new(session),
            shells: Arc::new(Mutex::new(HashMap::new())),
            encoding: resolve_encoding(&s.encoding),
            agent_forward: s.agent_forward,
            jump_connection_id,
        };
        self.connections
            .lock()
            .await
            .insert(connection_id.clone(), conn);
        // 连接成功：清除本次连接的主机密钥校验状态
        *pending.lock().await = None;
        Ok(connection_id)
    }

    /// 四种认证：密码 / 私钥 / 键盘交互(2FA) / SSH Agent。
    /// 返回认证是否成功；失败细节由调用方按 TOFU 流程或错误提示处理。
    async fn authenticate(
        &self,
        session: &mut client::Handle<SshClient>,
        s: &Session,
        connection_id: &str,
    ) -> Result<bool, String> {
        match s.auth_type.as_str() {
            "key" => {
                let path = s
                    .private_key_path
                    .as_deref()
                    .ok_or_else(|| "no private key path".to_string())?;
                let key = load_secret_key(path, s.private_key_passphrase.as_deref())
                    .map_err(|e| format!("load key failed: {e}"))?;
                Ok(session
                    .authenticate_publickey(
                        &s.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), None),
                    )
                    .await
                    .map_err(|e| format!("auth failed: {e}"))?
                    .success())
            }
            "keyboard" => self.authenticate_keyboard_interactive(session, s, connection_id).await,
            "agent" => self.authenticate_with_agent(session, s).await,
            _ => {
                let pwd = s.password.clone().unwrap_or_default();
                Ok(session
                    .authenticate_password(&s.username, &pwd)
                    .await
                    .map_err(|e| format!("auth failed: {e}"))?
                    .success())
            }
        }
    }

    /// 键盘交互认证（2FA/挑战应答）：服务端每轮提示经 `auth-prompt` 事件
    /// 推给前端填写，多轮直到成功/失败；用户取消或 120s 超时即报错。
    async fn authenticate_keyboard_interactive(
        &self,
        session: &mut client::Handle<SshClient>,
        s: &Session,
        connection_id: &str,
    ) -> Result<bool, String> {
        use client::KeyboardInteractiveAuthResponse as Response;
        let mut reply = session
            .authenticate_keyboard_interactive_start(&s.username, Option::<String>::None)
            .await
            .map_err(|e| format!("auth failed: {e}"))?;
        loop {
            match reply {
                Response::Success => return Ok(true),
                Response::Failure { .. } => return Ok(false),
                Response::InfoRequest {
                    name,
                    instructions,
                    prompts,
                } => {
                    let auth_id = format!("{connection_id}-{}", uuid::Uuid::new_v4());
                    let items: Vec<(String, bool)> = prompts
                        .iter()
                        .map(|p| (p.prompt.clone(), p.echo))
                        .collect();
                    log::info!(
                        "ssh: keyboard-interactive prompt ({} prompts) conn={connection_id}",
                        items.len()
                    );
                    let answers = self
                        .wait_auth_responses(&auth_id, &name, &instructions, &items)
                        .await?;
                    reply = session
                        .authenticate_keyboard_interactive_respond(answers)
                        .await
                        .map_err(|e| format!("auth failed: {e}"))?;
                }
            }
        }
    }

    /// SSH Agent 认证：枚举本地 agent 身份逐个尝试公钥认证。
    /// 无 agent / 无身份时给出可操作的中文错误，而不是笼统的失败。
    /// 用已连接 agent 中的身份逐个尝试公钥认证（Unix / Windows 共用）。
    async fn try_agent_identities<S>(
        session: &mut client::Handle<SshClient>,
        user: &str,
        identities: &[russh::keys::agent::AgentIdentity],
        agent: &mut S,
    ) -> bool
    where
        S: russh::Signer,
    {
        if identities.is_empty() {
            return false;
        }
        for id in identities {
            let key = match id {
                russh::keys::agent::AgentIdentity::PublicKey { key, .. } => key.clone(),
                // 证书身份走公钥流程无意义，直接跳过
                russh::keys::agent::AgentIdentity::Certificate { .. } => continue,
            };
            // ssh-key 0.7 的 Rsa 变体携带 hash 参数，用模式匹配判 RSA
            let hash_alg = if matches!(key.algorithm(), Algorithm::Rsa { .. }) {
                Some(HashAlg::Sha256)
            } else {
                None
            };
            if let Ok(result) = session
                .authenticate_publickey_with(user, key, hash_alg, agent)
                .await
            {
                if result.success() {
                    return true;
                }
            }
        }
        false
    }

    /// Unix：通过 SSH_AUTH_SOCK 连接本地 OpenSSH Agent。
    #[cfg(unix)]
    async fn authenticate_with_agent(
        &self,
        session: &mut client::Handle<SshClient>,
        s: &Session,
    ) -> Result<bool, String> {
        use russh::keys::agent::client::AgentClient;
        let mut agent = AgentClient::connect_env()
            .await
            .map_err(|e| format!("连接本地 SSH Agent 失败（是否已执行 ssh-add？）：{e}"))?;
        let identities = agent
            .request_identities()
            .await
            .map_err(|e| format!("读取 SSH Agent 身份失败：{e}"))?;
        if identities.is_empty() {
            return Err("SSH Agent 中没有可用密钥（请先 ssh-add 添加）".to_string());
        }
        Ok(Self::try_agent_identities(session, &s.username, &identities, &mut agent).await)
    }

    /// Windows：优先连接 Windows OpenSSH Agent 命名管道，失败再尝试 Pageant。
    #[cfg(windows)]
    async fn authenticate_with_agent(
        &self,
        session: &mut client::Handle<SshClient>,
        s: &Session,
    ) -> Result<bool, String> {
        use russh::keys::agent::client::AgentClient;
        if let Ok(mut agent) =
            AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await
        {
            let identities = agent
                .request_identities()
                .await
                .map_err(|e| format!("读取 SSH Agent 身份失败：{e}"))?;
            if identities.is_empty() {
                return Err("SSH Agent 中没有可用密钥（请先 ssh-add 添加）".to_string());
            }
            return Ok(
                Self::try_agent_identities(session, &s.username, &identities, &mut agent).await,
            );
        }
        let mut agent = AgentClient::connect_pageant().await.map_err(|e| {
            format!("连接本地 SSH Agent 失败（请启动 Windows OpenSSH Authentication Agent 或 Pageant）：{e}")
        })?;
        let identities = agent
            .request_identities()
            .await
            .map_err(|e| format!("读取 SSH Agent 身份失败：{e}"))?;
        if identities.is_empty() {
            return Err("SSH Agent 中没有可用密钥（请先 ssh-add 添加）".to_string());
        }
        Ok(Self::try_agent_identities(session, &s.username, &identities, &mut agent).await)
    }

    /// 其他平台：暂不支持 SSH Agent 认证（明确报错而不是编译失败）。
    #[cfg(not(any(unix, windows)))]
    async fn authenticate_with_agent(
        &self,
        _session: &mut client::Handle<SshClient>,
        _s: &Session,
    ) -> Result<bool, String> {
        Err("当前平台不支持 SSH Agent 认证".to_string())
    }

    /// 经跳板机建立到目标的 SSH 会话：
    /// 先连跳板（不支持嵌套跳板），再 open direct-tcpip 通道承载目标握手。
    /// 跳板连接同样纳入连接表管理，随目标连接一起清理。
    /// 目标主机的密钥校验结果写入调用方传入的 `target_pending`，
    /// 与直连走同一套 TOFU 信任流程。
    async fn connect_via_jump(
        &self,
        jump: &JumpTarget,
        target: &Session,
        config: Arc<client::Config>,
        target_pending: Arc<Mutex<Option<HostKeyStatus>>>,
        // 外层已生成的连接 id：目标会话断线自清理必须用它键控连接表
        target_conn_id: String,
        // 目标主机已信任指纹：经隧道握手时同样要做 TOFU 校验
        target_known_fingerprint: Option<String>,
    ) -> Result<(client::Handle<SshClient>, String), String> {
        if jump.session.jump_session_id.as_deref().is_some_and(|v| !v.is_empty()) {
            return Err("跳板机不支持嵌套（仅支持一级跳板）".to_string());
        }
        let jump_conn_id = uuid::Uuid::new_v4().to_string();
        let jump_pending = Arc::new(Mutex::new(None));
        let mut jump_session = client::connect(
            config.clone(),
            format!("{}:{}", jump.session.host, jump.session.port).as_str(),
            SshClient::new(
                self.forwards.clone(),
                jump.known_fingerprint.clone(),
                jump_pending.clone(),
                self.connections.clone(),
                jump_conn_id.clone(),
                false,
            ),
        )
        .await
        .map_err(|e| format!("jump connect failed: {e}"))?;
        // 跳板主机密钥校验失败：抛专用错误，前端走同一套信任流程后重试
        if let Some(status) = jump_pending.lock().await.take() {
            return Err(match status {
                HostKeyStatus::Unverified { fingerprint } => {
                    format!("JUMP_HOST_KEY_UNVERIFIED:{fingerprint}")
                }
                HostKeyStatus::Mismatch { fingerprint, expected } => {
                    format!("JUMP_HOST_KEY_CHANGED:{fingerprint}:{expected}")
                }
            });
        }
        let jump_ok = self
            .authenticate(&mut jump_session, &jump.session, &jump_conn_id)
            .await?;
        if !jump_ok {
            return Err("jump authentication failed".into());
        }
        // 跳板连接纳入连接表：断线自清理、随目标一起断开
        self.connections.lock().await.insert(
            jump_conn_id.clone(),
            Connection {
                handle: Arc::new(jump_session),
                shells: Arc::new(Mutex::new(HashMap::new())),
                encoding: resolve_encoding(&jump.session.encoding),
                agent_forward: false,
                jump_connection_id: None,
            },
        );
        let jump_handle = self
            .get_handle(&jump_conn_id)
            .await
            .ok_or_else(|| "jump connection lost".to_string())?;
        // direct-tcpip 通道直达目标，目标握手跑在这条流上
        let channel = jump_handle
            .channel_open_direct_tcpip(
                target.host.clone(),
                target.port as u32,
                "127.0.0.1",
                0,
            )
            .await
            .map_err(|e| format!("jump tunnel failed: {e}"))?;
        let stream = channel.into_stream();
        let target_session = client::connect_stream(
            config,
            stream,
            SshClient::new(
                self.forwards.clone(),
                target_known_fingerprint,
                target_pending,
                self.connections.clone(),
                target_conn_id,
                target.agent_forward,
            ),
        )
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
        Ok((target_session, jump_conn_id))
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
            // 经跳板建立的连接：目标断开时一并断开跳板连接，避免残留
            if let Some(jump_id) = conn.jump_connection_id {
                // 递归只走一层（跳板本身 jump_connection_id 为空，不会连锁）
                let _ = Box::pin(self.disconnect(&jump_id)).await;
            }
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
        let (handle, encoding) = {
            let cons = self.connections.lock().await;
            let conn = cons
                .get(connection_id)
                .ok_or_else(|| {
                    log::error!("exec_command: connection not found: {connection_id}");
                    "connection not found".to_string()
                })?;
            (conn.handle.clone(), conn.encoding)
        };
        let mut channel = handle.channel_open_session().await.map_err(|e| {
            log::error!("exec_command: open channel failed conn={connection_id}: {e}");
            format!("open channel failed: {e}")
        })?;
        channel.exec(true, command).await.map_err(|e| {
            log::error!("exec_command: exec failed conn={connection_id}: {e}");
            format!("exec failed: {e}")
        })?;
        let mut output = String::new();
        // 麒麟/Dropbear 等服务器执行 exec 后不会主动发送结束信号（无 exit-status/EOF/close），
        // 必须由客户端在输出结束后主动关闭。策略：
        // - 收到第一条数据前：给足命令执行宽限（top/df 在部分设备上可达数秒）
        // - 收到数据后：静默 2s 即认为输出完成，立即关闭，避免 channel 占用过久
        // 若服务器正常发送 close/EOF，则提前退出。
        let mut idle = Duration::from_secs(15);
        loop {
            match tokio::time::timeout(idle, channel.wait()).await {
                Ok(Some(ChannelMsg::Data { data })) => {
                    output.push_str(&decode_remote_bytes(&data, encoding));
                    idle = Duration::from_secs(2);
                }
                Ok(Some(ChannelMsg::ExitStatus { .. })) => {}
                Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) | Ok(None) => break,
                Ok(_) => {}
                // 静默超时：认为命令输出完成
                Err(_) => break,
            }
        }
        // 显式关闭 channel：russh 的 Channel drop 不会自动发送 CHANNEL_CLOSE，
        // 不关闭会导致服务器端 channel 累积（监控每 2s 轮询），最终被服务器拒绝打开
        let _ = channel.close().await;
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
        let (mut channel, shells, encoding) = {
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
            // 启用了 agent 转发：在 shell 通道上发送 auth-agent-req，
            // 服务端随即打开 agent 通道，由 server_channel_open_agent_forward 中转到本地。
            // 请求失败不阻断建 shell（服务端可能不支持），仅记录日志。
            if conn.agent_forward {
                if let Err(e) = channel.agent_forward(true).await {
                    log::warn!("ssh: agent-forward request failed conn={connection_id}: {e}");
                }
            }
            (channel, conn.shells.clone(), conn.encoding)
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
                            let text = decode_remote_bytes(&data, encoding);
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
        let (tx, encoding) = {
            let cons = self.connections.lock().await;
            let conn = cons
                .get(connection_id)
                .ok_or_else(|| "connection not found".to_string())?;
            let shells = conn.shells.lock().await;
            (shells.get(shell_id).cloned(), conn.encoding)
        };
        if let Some(tx) = tx {
            let bytes = encode_terminal_input(
                &String::from_utf8_lossy(&data).into_owned(),
                encoding,
            )?;
            tx.send(ShellCmd::Data(bytes))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_encoding_supports_utf8_and_gbk_aliases() {
        assert_eq!(resolve_encoding("utf-8"), encoding_rs::UTF_8);
        assert_eq!(resolve_encoding("UTF8"), encoding_rs::UTF_8);
        assert_eq!(resolve_encoding("gbk"), encoding_rs::GBK);
        assert_eq!(resolve_encoding("GB18030"), encoding_rs::GB18030);
        assert_eq!(resolve_encoding("unknown"), encoding_rs::UTF_8);
    }

    #[test]
    fn decode_and_encode_gbk_roundtrip() {
        let original = "连接成功 df -h";
        let encoded = encode_terminal_input(original, encoding_rs::GBK).unwrap();
        assert_ne!(encoded, original.as_bytes());
        assert_eq!(decode_remote_bytes(&encoded, encoding_rs::GBK), original);
    }

    #[test]
    fn decode_utf8_uses_lossy_fallback() {
        assert_eq!(
            decode_remote_bytes(b"ok\xff", encoding_rs::UTF_8),
            "ok\u{fffd}"
        );
    }

    /// 2FA 回填通道：应答只交付一次；取消会丢弃等待方；未知 id 报错。
    #[tokio::test]
    async fn auth_respond_delivers_once_and_cancel_drops_waiter() {
        let manager = SshManager::new();

        let (tx, rx) = tokio::sync::oneshot::channel();
        manager.pending_auth.lock().await.insert("a1".into(), tx);
        manager
            .auth_respond("a1", vec!["123456".into()])
            .await
            .expect("respond should deliver");
        assert_eq!(rx.await.unwrap(), vec!["123456".to_string()]);
        // 一次性：同一 id 不能重复回填
        assert!(manager.auth_respond("a1", vec![]).await.is_err());

        // 取消：等待方通道被丢弃，且后续回填报错
        let (tx2, rx2) = tokio::sync::oneshot::channel();
        manager.pending_auth.lock().await.insert("a2".into(), tx2);
        manager.auth_cancel("a2").await.expect("cancel existing");
        assert!(rx2.await.is_err(), "waiter should be dropped on cancel");
        assert!(manager.auth_respond("a2", vec![]).await.is_err());

        // 未知 id
        assert!(manager.auth_cancel("missing").await.is_err());
    }
}
