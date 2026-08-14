#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod crypto;
mod db;
mod forward;
mod models;
mod sftp;
mod ssh;

use tauri::Manager;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();
    tauri::Builder::default()
        .setup(|app| {
            // 开发模式：使用项目内数据目录（调试/沙箱环境下 ~/Library 可能不可写）；
            // release 构建保持系统标准数据目录。
            let data_dir = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join(".termix-data")
            } else {
                app.path().app_data_dir()?
            };
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("termix.db");
            let db = db::Db::open(db_path.to_str().ok_or("invalid db path")?)?;
            app.manage(commands::AppState::new(db));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session_list,
            commands::session_create,
            commands::session_update,
            commands::session_delete,
            commands::sessions_export,
            commands::sessions_import,
            commands::group_list,
            commands::group_create,
            commands::group_delete,
            commands::session_connect,
            commands::session_disconnect,
            commands::host_key_accept,
            commands::terminal_create,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_destroy,
            commands::history_list,
            commands::history_add,
            commands::history_clear,
            commands::sftp_list,
            commands::sftp_mkdir,
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
            commands::local_list,
            commands::local_home,
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
            commands::master_status,
            commands::master_set,
            commands::master_unlock,
            commands::master_lock,
            commands::master_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
