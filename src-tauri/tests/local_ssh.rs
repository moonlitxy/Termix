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
        created_at: 0,
        last_connected_at: None,
    }
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
