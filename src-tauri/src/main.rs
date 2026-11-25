#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;
use termix::{commands, db, updater};

struct StoragePaths {
    data_dir: PathBuf,
    default_download_dir: PathBuf,
    portable: bool,
}

fn repo_data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(".termix-data")
}

#[allow(dead_code)]
fn portable_data_dir(install_dir: &Path) -> PathBuf {
    install_dir.join("data")
}

#[allow(dead_code)]
fn portable_download_dir(install_dir: &Path) -> PathBuf {
    install_dir.join("downloads")
}

#[allow(dead_code)]
fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".termix-write-test-{}", std::process::id()));
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[allow(dead_code)]
fn copy_dir_if_missing(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.exists() || dst.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_if_missing(&entry.path(), &target)?;
        } else if entry.file_type()?.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// 首次切到便携目录时，把旧版 AppData 中的数据库和备份复制过来。
/// 只复制、不删除旧数据；目标目录已有数据库时不做覆盖。
#[allow(dead_code)]
fn migrate_legacy_data(legacy_dir: &Path, data_dir: &Path) -> Result<bool, String> {
    if legacy_dir == data_dir {
        return Ok(false);
    }
    let target_db = data_dir.join("termix.db");
    if target_db.exists() {
        return Ok(false);
    }
    let legacy_db = legacy_dir.join("termix.db");
    if !legacy_db.exists() {
        return Ok(false);
    }

    let tmp_db = data_dir.join("termix.db.migrating");
    fs::copy(&legacy_db, &tmp_db).map_err(|e| format!("copy legacy db failed: {e}"))?;
    fs::rename(&tmp_db, &target_db).map_err(|e| {
        let _ = fs::remove_file(&tmp_db);
        format!("move migrated db failed: {e}")
    })?;

    let legacy_backups = legacy_dir.join("backups");
    let target_backups = data_dir.join("backups");
    if let Err(e) = copy_dir_if_missing(&legacy_backups, &target_backups) {
        log::warn!(
            "storage: copied database but failed to copy backups from {}: {e}",
            legacy_backups.display()
        );
    }
    log::info!(
        "storage: migrated legacy data from {} to {}",
        legacy_dir.display(),
        data_dir.display()
    );
    Ok(true)
}

fn resolve_storage(
    debug: bool,
    install_dir: Option<&Path>,
    legacy_data_dir: &Path,
    system_download_dir: Option<&Path>,
) -> Result<StoragePaths, String> {
    #[cfg(not(target_os = "windows"))]
    let _ = install_dir;

    if debug {
        let data_dir = repo_data_dir();
        fs::create_dir_all(&data_dir).map_err(|e| format!("create data dir failed: {e}"))?;
        let default_download_dir = data_dir.join("downloads");
        let _ = fs::create_dir_all(&default_download_dir);
        return Ok(StoragePaths {
            data_dir,
            default_download_dir,
            portable: false,
        });
    }

    #[cfg(target_os = "windows")]
    if let Some(install_dir) = install_dir {
        let data_dir = portable_data_dir(install_dir);
        let data_ready = fs::create_dir_all(&data_dir).is_ok() && dir_writable(&data_dir);
        if data_ready {
            match migrate_legacy_data(legacy_data_dir, &data_dir) {
                Ok(_) => {
                    let default_download_dir = portable_download_dir(install_dir);
                    if let Err(e) = fs::create_dir_all(&default_download_dir) {
                        log::warn!(
                            "storage: create default download dir {} failed: {e}",
                            default_download_dir.display()
                        );
                    }
                    return Ok(StoragePaths {
                        data_dir,
                        default_download_dir,
                        portable: true,
                    });
                }
                Err(e) => {
                    log::warn!(
                        "storage: portable migration failed ({e}); falling back to system data dir"
                    );
                }
            }
        } else {
            log::warn!(
                "storage: install dir {} is not writable; falling back to system data dir",
                install_dir.display()
            );
        }
    }

    fs::create_dir_all(legacy_data_dir)
        .map_err(|e| format!("create system data dir failed: {e}"))?;
    let default_download_dir = system_download_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| legacy_data_dir.join("downloads"));
    let _ = fs::create_dir_all(&default_download_dir);
    Ok(StoragePaths {
        data_dir: legacy_data_dir.to_path_buf(),
        default_download_dir,
        portable: false,
    })
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();
    tauri::Builder::default()
        .setup(|app| {
            let install_dir = std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf));
            let legacy_data_dir = app.path().app_data_dir()?;
            let system_download_dir = app.path().download_dir().ok();
            let storage = resolve_storage(
                cfg!(debug_assertions),
                install_dir.as_deref(),
                &legacy_data_dir,
                system_download_dir.as_deref(),
            )?;
            let db_path = storage.data_dir.join("termix.db");
            let db = db::Db::open(db_path.to_str().ok_or("invalid db path")?)?;
            let app_state = commands::AppState::new(
                db,
                storage.data_dir,
                storage.default_download_dir,
                storage.portable,
            );
            // 键盘交互认证（2FA）需要向前端推送事件，提前注入应用句柄
            app_state.ssh.set_app_handle(app.handle().clone());
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session_list,
            commands::session_create,
            commands::session_update,
            commands::session_move,
            commands::session_delete,
            commands::sessions_export,
            commands::sessions_import,
            commands::ssh_config_read_default,
            commands::ssh_config_import,
            commands::backup_list,
            commands::backup_restore,
            commands::backup_now,
            commands::group_list,
            commands::group_create,
            commands::group_delete,
            commands::session_connect,
            commands::session_disconnect,
            commands::auth_respond,
            commands::auth_cancel,
            commands::host_key_accept,
            commands::terminal_create,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_destroy,
            commands::history_list,
            commands::history_add,
            commands::history_clear,
            commands::sftp_list,
            commands::sftp_list_enriched,
            commands::sftp_cwd,
            commands::sftp_canonical_dir,
            commands::sftp_mkdir,
            commands::sftp_create_file,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_chmod,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_upload_dir,
            commands::sftp_download_dir,
            commands::transfer_list,
            commands::transfer_cancel,
            commands::transfer_pause,
            commands::transfer_resume,
            commands::transfer_delete,
            commands::transfer_clear,
            commands::local_list,
            commands::local_home,
            commands::local_ensure_dir,
            commands::local_mkdir,
            commands::local_rename,
            commands::local_delete,
            commands::local_open_path,
            commands::local_reveal_path,
            commands::app_paths,
            commands::download_dir_set,
            commands::snippet_list,
            commands::snippet_create,
            commands::snippet_update,
            commands::snippet_delete,
            commands::forward_list,
            commands::forward_create,
            commands::forward_update,
            commands::forward_delete,
            commands::forward_start,
            commands::forward_stop,
            commands::monitor_metrics,
            commands::monitor_processes,
            commands::system_info,
            commands::master_status,
            commands::master_set,
            commands::master_unlock,
            commands::master_lock,
            commands::master_clear,
            updater::check_update,
            updater::download_update,
            updater::install_update,
            updater::open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod storage_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("termix-{name}-{}-{stamp}", std::process::id()))
    }

    #[test]
    fn portable_paths_are_under_install_dir() {
        let install = PathBuf::from("TermixInstall");
        assert_eq!(portable_data_dir(&install), install.join("data"));
        assert_eq!(portable_download_dir(&install), install.join("downloads"));
    }

    #[test]
    fn migrates_legacy_db_and_backups_without_overwriting() {
        let root = temp_root("migrate");
        let legacy = root.join("legacy");
        let target = root.join("data");
        fs::create_dir_all(legacy.join("backups")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("termix.db"), b"legacy-db").unwrap();
        fs::write(legacy.join("backups").join("one.json"), b"legacy-backup").unwrap();

        assert!(migrate_legacy_data(&legacy, &target).unwrap());
        assert_eq!(fs::read(target.join("termix.db")).unwrap(), b"legacy-db");
        assert_eq!(
            fs::read(target.join("backups").join("one.json")).unwrap(),
            b"legacy-backup"
        );

        fs::write(target.join("termix.db"), b"new-db").unwrap();
        assert!(!migrate_legacy_data(&legacy, &target).unwrap());
        assert_eq!(fs::read(target.join("termix.db")).unwrap(), b"new-db");

        let _ = fs::remove_dir_all(root);
    }
}
