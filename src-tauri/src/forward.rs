use std::collections::HashMap;
use std::sync::Arc;

use tokio::io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use crate::models::ForwardRule;
use crate::ssh::SshManager;

pub struct ForwardService {
    ssh: Arc<SshManager>,
    active: Mutex<HashMap<String, ActiveForward>>,
}

struct ActiveForward {
    handle: tokio::task::JoinHandle<()>,
    /// 远程转发的取消信息：(connection_id, 服务端监听地址, 服务端监听端口)
    remote_bind: Option<(String, String, u32)>,
}

/// 完成 SOCKS5 无认证握手，解析 CONNECT 目标地址。返回 (host, port)。
async fn socks5_handshake(socket: &mut TcpStream) -> Result<(String, u16), String> {
    // 版本与方法协商：05 01 00
    let mut buf = [0u8; 2];
    socket.read_exact(&mut buf).await.map_err(|e| format!("read greeting: {e}"))?;
    if buf[0] != 5 {
        return Err("not a socks5 client".into());
    }
    let nmethods = buf[1] as usize;
    let mut methods = vec![0u8; nmethods];
    socket
        .read_exact(&mut methods)
        .await
        .map_err(|e| format!("read methods: {e}"))?;
    // 选择无认证
    socket.write_all(&[5, 0]).await.map_err(|e| format!("write method: {e}"))?;

    // CONNECT 请求：05 01 00 ATYP DST.ADDR DST.PORT
    let mut head = [0u8; 4];
    socket.read_exact(&mut head).await.map_err(|e| format!("read request: {e}"))?;
    if head[0] != 5 || head[1] != 1 {
        return Err("unsupported socks5 command".into());
    }
    let host = match head[3] {
        1 => {
            // IPv4
            let mut a = [0u8; 4];
            socket.read_exact(&mut a).await.map_err(|e| format!("read ipv4: {e}"))?;
            format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3])
        }
        3 => {
            // 域名
            let mut l = [0u8; 1];
            socket.read_exact(&mut l).await.map_err(|e| format!("read addr len: {e}"))?;
            let mut d = vec![0u8; l[0] as usize];
            socket.read_exact(&mut d).await.map_err(|e| format!("read domain: {e}"))?;
            String::from_utf8_lossy(&d).into_owned()
        }
        4 => {
            // IPv6
            let mut a = [0u8; 16];
            socket.read_exact(&mut a).await.map_err(|e| format!("read ipv6: {e}"))?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => return Err("unsupported address type".into()),
    };
    let mut port = [0u8; 2];
    socket.read_exact(&mut port).await.map_err(|e| format!("read port: {e}"))?;
    let port = u16::from_be_bytes(port);
    // 回复成功：05 00 00 01 0.0.0.0 0
    socket
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| format!("write reply: {e}"))?;
    Ok((host, port))
}

impl ForwardService {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self {
            ssh,
            active: Mutex::new(HashMap::new()),
        }
    }

    /// 启动端口转发（支持 local / dynamic / remote）。
    pub async fn start(&self, rule: &ForwardRule) -> Result<(), String> {
        match rule.rtype.as_str() {
            "remote" => return self.start_remote(rule).await,
            "local" | "dynamic" => {}
            _ => {
                log::warn!("forward: start rule={} type={} not supported", rule.id, rule.rtype);
                return Err("不支持的转发类型".into());
            }
        }
        let session_id = rule
            .session_id
            .as_deref()
            .ok_or_else(|| {
                log::warn!("forward: start rule={} without bound session", rule.id);
                "规则未绑定会话".to_string()
            })?;
        let ssh_handle = self
            .ssh
            .get_handle(session_id)
            .await
            .ok_or_else(|| {
                log::warn!("forward: start rule={} session {session_id} not connected", rule.id);
                "绑定会话未连接".to_string()
            })?;

        let addr = format!("{}:{}", rule.local_host, rule.local_port);
        let listener = TcpListener::bind(&addr).await.map_err(|e| {
            log::error!(
                "forward: bind failed rule={} addr={addr}: {e}",
                rule.id
            );
            format!("绑定本地端口失败（可能被占用）: {e}")
        })?;
        log::info!(
            "forward: started rule={} name={} local={}:{} -> remote={}:{} via session {session_id}",
            rule.id,
            rule.name,
            rule.local_host,
            rule.local_port,
            rule.remote_host,
            rule.remote_port
        );

        let remote_host = rule.remote_host.clone();
        let remote_port = rule.remote_port;
        let is_dyn = rule.rtype == "dynamic";
        let id = rule.id.clone();
        let loop_id = id.clone();

        let handle = tokio::spawn(async move {
            log::debug!("forward: accept loop started for rule {loop_id} (dynamic={is_dyn})");
            loop {
                match listener.accept().await {
                    Ok((mut socket, peer)) => {
                        log::debug!("forward: rule {loop_id} accepted connection from {peer}");
                        let ssh = ssh_handle.clone();
                        let rh = remote_host.clone();
                        let rp = remote_port;
                        let lid = loop_id.clone();
                        let dyn_flag = is_dyn;
                        tokio::spawn(async move {
                            // 动态代理：先完成 SOCKS5 握手获取目标地址
                            let (target_host, target_port) = if dyn_flag {
                                match socks5_handshake(&mut socket).await {
                                    Ok(t) => {
                                        log::debug!(
                                            "forward: rule {lid} socks5 CONNECT -> {}:{}",
                                            t.0,
                                            t.1
                                        );
                                        (t.0, t.1 as u32)
                                    }
                                    Err(e) => {
                                        log::debug!("forward: rule {lid} socks5 handshake failed: {e}");
                                        return;
                                    }
                                }
                            } else {
                                (rh.clone(), rp)
                            };
                            let channel = match ssh
                                .channel_open_direct_tcpip(target_host.clone(), target_port, "127.0.0.1", 0)
                                .await
                            {
                                Ok(c) => c,
                                Err(e) => {
                                    log::error!(
                                        "forward: rule {lid} open direct-tcpip to {target_host}:{target_port} failed: {e}"
                                    );
                                    return;
                                }
                            };
                            log::debug!(
                                "forward: rule {lid} tunnel established to {target_host}:{target_port}"
                            );
                            let mut stream = channel.into_stream();
                            match copy_bidirectional(&mut socket, &mut stream).await {
                                Ok((to_srv, to_cli)) => {
                                    log::debug!(
                                        "forward: rule {lid} connection closed ({}b -> server, {}b -> client)",
                                        to_srv,
                                        to_cli
                                    );
                                }
                                Err(e) => {
                                    log::debug!("forward: rule {lid} tunnel error: {e}");
                                }
                            }
                        });
                    }
                    Err(e) => {
                        log::error!("forward: rule {loop_id} accept error: {e}");
                        break;
                    }
                }
            }
            log::info!("forward: accept loop for rule {loop_id} exited");
        });

        if let Some(prev) = self.active.lock().await.remove(&id) {
            log::info!("forward: replacing existing active rule {id}");
            prev.handle.abort();
        }
        self.active
            .lock()
            .await
            .insert(id, ActiveForward { handle, remote_bind: None });
        Ok(())
    }

    /// 远程端口转发：请求服务端监听端口，连接推送到本机后转发到本地目标。
    async fn start_remote(&self, rule: &ForwardRule) -> Result<(), String> {
        let session_id = rule
            .session_id
            .as_deref()
            .ok_or_else(|| {
                log::warn!("forward: start_remote rule={} without bound session", rule.id);
                "规则未绑定会话".to_string()
            })?;
        // 服务端监听地址（远程地址字段）；空则默认 0.0.0.0
        let bind_host = if rule.remote_host.is_empty() {
            "0.0.0.0".to_string()
        } else {
            rule.remote_host.clone()
        };
        let bind_port = rule.remote_port;
        // 本地目标：转发到本机运行的服务的地址与端口
        let local_host = if rule.local_host.is_empty() {
            "127.0.0.1".to_string()
        } else {
            rule.local_host.clone()
        };
        let local_port = rule.local_port as u16;

        let actual = self
            .ssh
            .request_remote_forward(session_id, &bind_host, bind_port)
            .await?;
        self.ssh
            .register_remote_forward(bind_port, &local_host, local_port);
        log::info!(
            "forward: remote rule={} server bound {bind_host}:{actual} -> local {local_host}:{local_port} via session {session_id}",
            rule.id
        );

        let id = rule.id.clone();
        if let Some(prev) = self.active.lock().await.remove(&id) {
            log::info!("forward: replacing existing active rule {id}");
            prev.handle.abort();
        }
        // 远程转发无本地 accept 循环，用一个常驻 pending 任务占位以便 stop 时取消
        let handle = tokio::spawn(std::future::pending::<()>());
        self.active.lock().await.insert(
            id,
            ActiveForward {
                handle,
                remote_bind: Some((session_id.to_string(), bind_host, bind_port)),
            },
        );
        Ok(())
    }

    pub async fn stop(&self, id: &str) -> Result<(), String> {
        if let Some(a) = self.active.lock().await.remove(id) {
            log::info!("forward: stopping rule {id}");
            a.handle.abort();
            // 远程转发需向服务端取消监听并注销本地目标
            if let Some((conn_id, host, port)) = a.remote_bind {
                self.ssh.unregister_remote_forward(port);
                if let Err(e) = self.ssh.cancel_remote_forward(&conn_id, &host, port).await {
                    log::warn!("forward: cancel remote forward {host}:{port} failed: {e}");
                }
            }
        } else {
            log::debug!("forward: stop rule {id} not running (nothing to do)");
        }
        Ok(())
    }

    /// 停止全部转发（会话断开时调用）。
    pub async fn stop_all(&self) {
        let mut act = self.active.lock().await;
        if !act.is_empty() {
            log::info!("forward: stopping all {} active rules", act.len());
        }
        for (id, a) in act.drain() {
            log::debug!("forward: stopping rule {id}");
            a.handle.abort();
            if let Some((_conn_id, host, port)) = a.remote_bind {
                self.ssh.unregister_remote_forward(port);
                log::info!("forward: dropping remote bind {host}:{port} (connection closing)");
            }
        }
    }
}
