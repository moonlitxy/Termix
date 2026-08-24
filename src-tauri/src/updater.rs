use std::cmp::Ordering;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

/// 更新检查结果（返回给前端展示）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 当前安装版本
    pub current_version: String,
    /// 远端最新版本
    pub latest_version: String,
    /// 是否有新版本
    pub has_update: bool,
    /// Release 页面链接
    pub release_url: String,
    /// 当前平台安装包直链（无匹配资产时为空串）
    pub asset_url: String,
    /// 安装包文件名
    pub asset_name: String,
    /// 更新说明（Markdown 正文）
    pub release_notes: String,
}

/// GitHub latest release 响应（仅反序列化所需字段）
#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

const LATEST_URL: &str = "https://api.github.com/repos/moonlitxy/Termix/releases/latest";
const USER_AGENT: &str = "Termix-Updater";

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))
}

/// 当前平台安装包扩展名：Windows 走 NSIS EXE，其余按 DMG 处理
fn platform_ext() -> &'static str {
    if cfg!(target_os = "windows") {
        "exe"
    } else {
        "dmg"
    }
}

/// 从 release 资产中挑选当前平台的安装包（macOS 选 .dmg，Windows 选 .exe）
fn pick_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    let ext = platform_ext();
    assets.iter().find(|a| a.name.ends_with(&format!(".{ext}")))
}

/// 解析 "v1.2.3" / "1.2.3" 为数值段，非数字段（pre-release 后缀等）按 0 处理
fn parse_version(v: &str) -> Vec<u64> {
    v.trim_start_matches('v')
        .split(['.', '-', '+'])
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect()
}

/// 比较两个版本号：a 比 b 新返回 Greater
fn compare_versions(a: &str, b: &str) -> Ordering {
    let (mut av, mut bv) = (parse_version(a), parse_version(b));
    let len = av.len().max(bv.len());
    av.resize(len, 0);
    bv.resize(len, 0);
    av.cmp(&bv)
}

fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 查询 GitHub 最新 release，返回版本对比结果与安装包下载信息
#[tauri::command]
pub async fn check_update() -> Result<UpdateInfo, String> {
    let client = http_client()?;
    let resp = client
        .get(LATEST_URL)
        .send()
        .await
        .map_err(|e| format!("检查更新失败（无法连接更新服务）：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("检查更新失败（更新服务返回 {}）", resp.status()));
    }
    let gh: GhRelease = resp
        .json()
        .await
        .map_err(|e| format!("解析更新信息失败：{e}"))?;

    let latest = gh.tag_name.trim_start_matches('v').to_string();
    let cur = current_version();
    let has_update = compare_versions(&latest, &cur) == Ordering::Greater;
    let asset = pick_asset(&gh.assets);
    Ok(UpdateInfo {
        current_version: cur,
        latest_version: latest,
        has_update,
        release_url: gh.html_url,
        asset_url: asset
            .map(|a| a.browser_download_url.clone())
            .unwrap_or_default(),
        asset_name: asset.map(|a| a.name.clone()).unwrap_or_default(),
        release_notes: gh.body.unwrap_or_default(),
    })
}

/// 后台下载安装包：立即返回，进度 / 完成 / 失败通过事件推送
#[tauri::command]
pub async fn download_update(app: AppHandle, url: String, file_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_download(&app, &url, &file_name).await {
            let _ = app.emit("update-download-error", json!({ "error": e }));
        }
    });
    Ok(())
}

async fn run_download(app: &AppHandle, url: &str, file_name: &str) -> Result<(), String> {
    let client = http_client()?;
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载安装包失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载安装包失败（服务器返回 {}）", resp.status()));
    }
    // 保存到系统下载目录，失败回退系统临时目录
    let dir = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let path = dir.join(file_name);
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("创建下载文件失败：{e}"))?;
    let mut received: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断：{e}"))? {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入下载文件失败：{e}"))?;
        received += chunk.len() as u64;
        let percent = if total > 0 {
            ((received as f64 / total as f64) * 100.0) as u32
        } else {
            0
        };
        let _ = app.emit(
            "update-download-progress",
            json!({ "fileName": file_name, "received": received, "total": total, "percent": percent }),
        );
    }
    let _ = file.flush().await;
    let _ = app.emit(
        "update-download-done",
        json!({ "fileName": file_name, "path": path.to_string_lossy() }),
    );
    Ok(())
}

/// 打开已下载的安装包：macOS 挂载 DMG，Windows 启动 EXE 安装程序
#[tauri::command]
pub async fn open_installer(path: String) -> Result<(), String> {
    open_with_system(&path)
}

/// 用系统默认方式打开外部链接（Release 下载页等）
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开链接失败：{e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("打开链接失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("当前平台暂不支持外部链接打开".to_string())
    }
}

fn open_with_system(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开安装包失败：{e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(path)
            .spawn()
            .map_err(|e| format!("启动安装程序失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("当前平台暂不支持自动安装".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_version_orders_numeric_segments() {
        assert_eq!(compare_versions("1.0.1", "1.0.1"), Ordering::Equal);
        assert_eq!(compare_versions("v1.0.1", "1.0.1"), Ordering::Equal);
        assert_eq!(compare_versions("1.1.0", "1.0.1"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.2", "1.0.1"), Ordering::Greater);
        assert_eq!(compare_versions("1.10.0", "1.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.1", "1.1.0"), Ordering::Less);
        // 跨大版本时 pre-release 后缀版本仍视为更新
        assert_eq!(compare_versions("2.0.0-beta.1", "1.9.0"), Ordering::Greater);
    }

    #[test]
    fn pick_asset_matches_current_platform() {
        let assets = vec![
            GhAsset {
                name: "termix-v1.0.1-source.tar.gz".into(),
                browser_download_url: "src-url".into(),
            },
            GhAsset {
                name: "Termix_1.0.1_aarch64.dmg".into(),
                browser_download_url: "dmg-url".into(),
            },
            GhAsset {
                name: "Termix_1.0.1_x64-setup.exe".into(),
                browser_download_url: "exe-url".into(),
            },
        ];
        let asset = pick_asset(&assets).expect("should match an installer asset");
        let ext = if cfg!(target_os = "windows") { "exe" } else { "dmg" };
        assert!(asset.name.ends_with(ext));
    }
}
