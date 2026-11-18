use std::sync::Arc;

use termix::models::Session;
use termix::sftp::SftpService;
use termix::ssh::{HostKeyStatus, SshManager};
use tokio::sync::Mutex;

fn local_sshd_config() -> Option<(u16, String, String, String, String)> {
    let (Ok(port), Ok(key), Ok(sandbox), Ok(fingerprint)) = (
        std::env::var("TERMIX_TEST_SSH_PORT"),
        std::env::var("TERMIX_TEST_SSH_KEY"),
        std::env::var("TERMIX_TEST_SSH_SANDBOX"),
        std::env::var("TERMIX_TEST_SSH_FINGERPRINT"),
    ) else {
        return None;
    };
    let user = std::env::var("TERMIX_TEST_SSH_USER").unwrap_or_else(|_| "mac".into());
    Some((
        port.parse().expect("invalid test ssh port"),
        key,
        sandbox,
        fingerprint,
        user,
    ))
}

fn local_sshd_session(port: u16, key: String, user: String) -> Session {
    Session {
        id: "local-test".into(),
        name: "local-test".into(),
        host: "127.0.0.1".into(),
        port,
        username: user,
        auth_type: "key".into(),
        password: None,
        private_key_path: Some(key),
        private_key_passphrase: None,
        group_id: None,
        memo: None,
        encoding: "utf-8".into(),
        jump_session_id: None,
        agent_forward: false,
        created_at: 0,
        last_connected_at: None,
    }
}

/// SSH Agent 认证端到端：需显式设置 TERMIX_TEST_AGENT=1，且外部已起
/// ssh-agent 并 ssh-add 测试私钥、传入 SSH_AUTH_SOCK；否则跳过（CI 默认跳过）。
#[tokio::test]
async fn local_sshd_agent_auth_when_configured() {
    if std::env::var("TERMIX_TEST_AGENT").ok().as_deref() != Some("1") {
        eprintln!("skip agent auth test: set TERMIX_TEST_AGENT=1 to enable");
        return;
    }
    let Some((port, _key, _sandbox, fingerprint, user)) = local_sshd_config() else {
        eprintln!("skip agent auth test: TERMIX_TEST_SSH_* not configured");
        return;
    };
    if std::env::var("SSH_AUTH_SOCK").is_err() {
        eprintln!("skip agent auth test: SSH_AUTH_SOCK not set");
        return;
    }
    let mut session = local_sshd_session(port, String::new(), user);
    session.auth_type = "agent".into();
    session.private_key_path = None;
    let manager = Arc::new(SshManager::new());
    let pending = Arc::new(Mutex::new(None));
    let connection_id = manager
        .connect(session, None, Some(fingerprint), pending)
        .await
        .expect("agent auth to local sshd");
    let output = manager
        .exec_command(&connection_id, "printf agent-auth-ok")
        .await
        .expect("exec over agent-authenticated connection");
    assert!(output.contains("agent-auth-ok"), "unexpected output: {output}");
    manager.disconnect(&connection_id).await.unwrap();
}

/// 跳板机端到端：用本地 sshd 同时充当跳板与目标，
/// 真实走「跳板握手 → direct-tcpip 隧道 → 目标握手 → 认证 → exec」整条链路。
/// 两台主机是同一实例，但隧道与双层认证代码路径与生产一致。
#[tokio::test]
async fn local_sshd_jump_host_when_configured() {
    let Some((port, key, _sandbox, fingerprint, user)) = local_sshd_config() else {
        eprintln!("skip jump-host test: TERMIX_TEST_SSH_* not configured");
        return;
    };
    let manager = Arc::new(SshManager::new());

    // 跳板会话：与目标同一台测试机
    let mut jump_session = local_sshd_session(port, key.clone(), user.clone());
    jump_session.id = "jump-test".into();
    jump_session.name = "jump-test".into();

    let target = local_sshd_session(port, key, user);
    let pending = Arc::new(Mutex::new(None));
    let connection_id = manager
        .connect(
            target,
            Some(termix::ssh::JumpTarget {
                session: jump_session,
                known_fingerprint: Some(fingerprint.clone()),
            }),
            Some(fingerprint),
            pending,
        )
        .await
        .expect("connect through jump host");

    let output = manager
        .exec_command(&connection_id, "printf jump-ok")
        .await
        .expect("exec over jump-tunneled connection");
    assert!(output.contains("jump-ok"), "unexpected output: {output}");

    // 断开目标应连带清理跳板连接（disconnect 内递归处理）
    manager.disconnect(&connection_id).await.unwrap();
}

#[tokio::test]
async fn local_sshd_exec_and_sftp_when_configured() {
    let Some((port, key, sandbox, fingerprint, user)) = local_sshd_config() else {
        eprintln!("skip local sshd test: TERMIX_TEST_SSH_* not configured");
        return;
    };
    let manager = Arc::new(SshManager::new());
    let pending = Arc::new(Mutex::new(None));
    let connection_id = manager
        .connect(
            local_sshd_session(port, key, user),
            None,
            Some(fingerprint),
            pending,
        )
        .await
        .expect("connect to local sshd");
    let output = manager
        .exec_command(&connection_id, "printf local-exec-ok")
        .await
        .expect("exec command");
    assert_eq!(output, "local-exec-ok");

    let sftp = SftpService::new(manager.clone());
    let file_name = format!("termix-sftp-{}.txt", uuid::Uuid::new_v4());
    let file_path = format!("{sandbox}/{file_name}");
    let renamed_path = format!("{file_path}.renamed");
    sftp.create_file(&connection_id, &file_path)
        .await
        .expect("sftp create file");
    let items = sftp
        .list(&connection_id, &sandbox)
        .await
        .expect("sftp list");
    assert!(items.iter().any(|item| item.path == file_path));
    sftp.rename(&connection_id, &file_path, &renamed_path)
        .await
        .expect("sftp rename");
    sftp.remove(&connection_id, &renamed_path, false)
        .await
        .expect("sftp remove");

    let dir_name = format!("termix-sftp-dir-{}", uuid::Uuid::new_v4());
    let dir_path = format!("{sandbox}/{dir_name}");
    sftp.mkdir(&connection_id, &dir_path)
        .await
        .expect("sftp mkdir");
    sftp.chmod(&connection_id, &dir_path, 0o755)
        .await
        .expect("sftp chmod");
    let items = sftp
        .list(&connection_id, &sandbox)
        .await
        .expect("sftp list dir");
    assert!(items
        .iter()
        .any(|item| item.path == dir_path && item.is_dir));
    sftp.remove(&connection_id, &dir_path, true)
        .await
        .expect("sftp remove dir");

    sftp.drop_session(&connection_id).await;
    manager
        .disconnect(&connection_id)
        .await
        .expect("disconnect");
}

#[tokio::test]
async fn local_sshd_rejects_wrong_host_fingerprint_when_configured() {
    let Some((port, key, _, fingerprint, user)) = local_sshd_config() else {
        eprintln!("skip local sshd test: TERMIX_TEST_SSH_* not configured");
        return;
    };
    let manager = Arc::new(SshManager::new());
    let pending = Arc::new(Mutex::new(None));
    let result = manager
        .connect(
            local_sshd_session(port, key, user),
            None,
            Some("SHA256:deliberately-wrong".into()),
            pending.clone(),
        )
        .await;
    assert!(result.is_err(), "wrong host fingerprint must be rejected");
    match pending.lock().await.as_ref() {
        Some(HostKeyStatus::Mismatch {
            fingerprint: actual,
            expected,
        }) => {
            assert_eq!(expected, "SHA256:deliberately-wrong");
            assert_eq!(actual, &fingerprint);
        }
        other => panic!("expected HostKeyStatus::Mismatch, got {other:?}"),
    };
}
