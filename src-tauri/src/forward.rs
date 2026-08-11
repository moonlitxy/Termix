use std::collections::HashMap;
use std::sync::Arc;

use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::models::ForwardRule;
use crate::ssh::SshManager;

pub struct ForwardService {
    ssh: Arc<SshManager>,
    active: Mutex<HashMap<String, ActiveForward>>,
}

struct ActiveForward {
    handle: tokio::task::JoinHandle<()>,
}

impl ForwardService {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self {
            ssh,
            active: Mutex::new(HashMap::new()),
        }
    }

    /// 启动端口转发（当前支持 local 本地转发；remote/dynamic 暂不支持）。
    pub async fn start(&self, rule: &ForwardRule) -> Result<(), String> {
        if rule.rtype != "local" {
            log::warn!(
                "forward: start rule={} type={} not supported (only local)",
                rule.id,
                rule.rtype
            );
            return Err("当前版本仅支持本地端口转发 (local)".into());
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
        let id = rule.id.clone();
        let loop_id = id.clone();

        let handle = tokio::spawn(async move {
            log::debug!("forward: accept loop started for rule {loop_id}");
            loop {
                match listener.accept().await {
                    Ok((mut socket, peer)) => {
                        log::debug!("forward: rule {loop_id} accepted connection from {peer}");
                        let ssh = ssh_handle.clone();
                        let rh = remote_host.clone();
                        let rp = remote_port;
                        let lid = loop_id.clone();
                        tokio::spawn(async move {
                            let channel = match ssh
                                .channel_open_direct_tcpip(rh.clone(), rp, "127.0.0.1", 0)
                                .await
                            {
                                Ok(c) => c,
                                Err(e) => {
                                    log::error!(
                                        "forward: rule {lid} open direct-tcpip to {rh}:{rp} failed: {e}"
                                    );
                                    return;
                                }
                            };
                            log::debug!("forward: rule {lid} tunnel established to {rh}:{rp}");
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
        self.active.lock().await.insert(id, ActiveForward { handle });
        Ok(())
    }

    pub async fn stop(&self, id: &str) -> Result<(), String> {
        if let Some(a) = self.active.lock().await.remove(id) {
            log::info!("forward: stopping rule {id}");
            a.handle.abort();
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
        }
    }
}
