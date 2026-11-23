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
    /// 本次实际连通的通道（mirror 基址 / "direct"），用于界面如实展示
    pub source: String,
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
/// 版本检查只请求小 JSON，保持短超时。
const CHECK_TIMEOUT_SECS: u64 = 20;
/// 下载安装包单独设置连接超时与总超时，避免大文件被短超时截断。
const DOWNLOAD_CONNECT_TIMEOUT_SECS: u64 = 15;
const DOWNLOAD_TIMEOUT_SECS: u64 = 30 * 60;

/// 镜像基址校验：仅允许 http(s)，统一补末尾 /（前端已规范过，这里是后端兜底）
fn normalize_mirror_base(raw: &str) -> Result<String, String> {
    let base = raw.trim();
    if base.is_empty() {
        return Err("镜像地址为空".to_string());
    }
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("镜像地址仅支持 http(s)".to_string());
    }
    if base.contains(char::is_whitespace) {
        return Err("镜像地址含非法空白字符".to_string());
    }
    if base.ends_with('/') {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}/"))
    }
}

/// 原 URL 套镜像前缀（如 https://gh-proxy.com/https://api.github.com/…）；
/// 镜像为空表示直连，原样返回。
fn apply_mirror(url: &str, mirror: Option<&str>) -> Result<String, String> {
    match mirror.map(str::trim).filter(|m| !m.is_empty()) {
        None => Ok(url.to_string()),
        Some(raw) => Ok(format!("{}{url}", normalize_mirror_base(raw)?)),
    }
}

/// 构建带可选代理的客户端；超时由调用方按场景设置。
fn client_builder(proxy: Option<&str>) -> Result<reqwest::ClientBuilder, String> {
    let mut builder = reqwest::Client::builder().user_agent(USER_AGENT);
    if let Some(p) = proxy.map(str::trim).filter(|p| !p.is_empty()) {
        let proxy = reqwest::Proxy::all(p).map_err(|e| format!("代理地址无效（{p}）：{e}"))?;
        builder = builder.proxy(proxy);
    }
    Ok(builder)
}

/// 版本检查只请求很小的 JSON，20 秒总超时足够。
fn http_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    client_builder(proxy)?
        .timeout(std::time::Duration::from_secs(CHECK_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))
}

/// 安装包体积较大，不能沿用版本检查的 20 秒总超时；
/// 否则镜像或代理稍慢就会在读取响应体时被强制中断。
fn download_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    client_builder(proxy)?
        .connect_timeout(std::time::Duration::from_secs(
            DOWNLOAD_CONNECT_TIMEOUT_SECS,
        ))
        .timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
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

/// 内置可用镜像（与前端 `UPDATE_MIRRORS` 保持一致，作为后端兜底顺序）。
const FALLBACK_MIRRORS: [&str; 2] = ["https://gh-proxy.com/", "https://gh-proxy.org/"];

/// 检查更新的候选通道：用户所选通道优先，其次其余内置镜像，最后直连兜底。
/// - 镜像模式：所选镜像 → 其它镜像 → 直连
/// - 直连模式：直连 → 内置镜像（直连不通时仍可拿到更新信息）
/// 纯函数，便于测试顺序与去重行为。
fn update_candidates(configured: Option<&str>) -> Vec<Option<String>> {
    let mut out: Vec<Option<String>> = Vec::new();
    match configured.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => out.push(Some(
            normalize_mirror_base(m).unwrap_or_else(|_| m.to_string()),
        )),
        None => out.push(None),
    }
    for m in FALLBACK_MIRRORS {
        if !out.iter().any(|c| c.as_deref() == Some(m)) {
            out.push(Some(m.to_string()));
        }
    }
    if !out.contains(&None) {
        out.push(None);
    }
    out
}

/// 把 reqwest 错误展开成可读链路（DNS / TLS / 超时等原始原因）。
fn describe_reqwest_error(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut msg = if e.is_timeout() {
        "请求超时".to_string()
    } else if e.is_connect() {
        "无法建立连接".to_string()
    } else {
        e.to_string()
    };
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(&format!(" → {s}"));
        src = s.source();
    }
    msg
}

/// 查询 GitHub 最新 release，返回版本对比结果与安装包下载信息。
/// 所选通道失败时自动尝试其余镜像与直连，取第一个成功的结果。
#[tauri::command]
pub async fn check_update(
    mirror: Option<String>,
    proxy: Option<String>,
) -> Result<UpdateInfo, String> {
    let client = http_client(proxy.as_deref())?;
    let candidates = update_candidates(mirror.as_deref());
    let mut failures: Vec<String> = Vec::new();

    for candidate in &candidates {
        let latest_url = match apply_mirror(LATEST_URL, candidate.as_deref()) {
            Ok(u) => u,
            Err(e) => {
                failures.push(format!("{}：{e}", candidate.as_deref().unwrap_or("direct")));
                continue;
            }
        };
        let label = candidate.as_deref().unwrap_or("direct");
        let resp = match client.get(latest_url).send().await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("check_update: {label} failed: {e}");
                failures.push(format!("{label}：{}", describe_reqwest_error(&e)));
                continue;
            }
        };
        if !resp.status().is_success() {
            failures.push(format!("{label}：更新服务返回 {}", resp.status()));
            continue;
        }
        let gh: GhRelease = match resp.json().await {
            Ok(g) => g,
            Err(e) => {
                failures.push(format!("{label}：解析失败 {}", describe_reqwest_error(&e)));
                continue;
            }
        };

        let latest = gh.tag_name.trim_start_matches('v').to_string();
        let cur = current_version();
        let has_update = compare_versions(&latest, &cur) == Ordering::Greater;
        let asset = pick_asset(&gh.assets);
        let asset_url = match asset {
            Some(a) => apply_mirror(&a.browser_download_url, candidate.as_deref()).unwrap_or_default(),
            None => String::new(),
        };
        if !failures.is_empty() {
            log::info!("check_update: succeeded via {label} after {} fallback(s)", failures.len());
        }
        return Ok(UpdateInfo {
            current_version: cur,
            latest_version: latest,
            has_update,
            release_url: gh.html_url,
            asset_url,
            asset_name: asset.map(|a| a.name.clone()).unwrap_or_default(),
            release_notes: gh.body.unwrap_or_default(),
            source: label.to_string(),
        });
    }

    Err(format!(
        "检查更新失败（所有通道均不可用）：\n{}",
        failures.join("\n")
    ))
}

/// 后台下载安装包：立即返回，进度 / 完成 / 失败通过事件推送
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    url: String,
    file_name: String,
    proxy: Option<String>,
) -> Result<(), String> {
    sanitize_installer_name(&file_name)?;
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_download(&app, &url, &file_name, proxy.as_deref()).await {
            let _ = app.emit("update-download-error", json!({ "error": e }));
        }
    });
    Ok(())
}

/// 校验外部链接：仅允许 http(s) 协议，杜绝恶意伪协议与空白注入
fn validate_external_url(raw: &str) -> Result<&str, String> {
    let u = raw.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("外部链接仅允许 http(s) 协议".to_string());
    }
    if u.contains(char::is_whitespace) {
        return Err("链接包含非法空白字符".to_string());
    }
    Ok(u)
}

/// 过滤安装包文件名：防止路径穿越（..）并限制安装包类型（exe / dmg）
fn sanitize_installer_name(raw: &str) -> Result<&str, String> {
    let name = raw.trim();
    let safe = std::path::Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty() && *n == name)
        .ok_or_else(|| "非法安装包文件名".to_string())?;
    let ext = std::path::Path::new(safe)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if !ext.eq_ignore_ascii_case("exe") && !ext.eq_ignore_ascii_case("dmg") {
        return Err("非法安装包扩展名（仅支持 exe/dmg）".to_string());
    }
    Ok(safe)
}

async fn run_download(
    app: &AppHandle,
    url: &str,
    file_name: &str,
    proxy: Option<&str>,
) -> Result<(), String> {
    let safe_name = sanitize_installer_name(file_name)?;
    let client = download_client(proxy)?;
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载安装包失败：{}", describe_reqwest_error(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("下载安装包失败（服务器返回 {}）", resp.status()));
    }
    // 保存到系统下载目录，失败回退系统临时目录
    let dir = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let path = dir.join(safe_name);
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("创建下载文件失败：{e}"))?;
    let mut received: u64 = 0;
    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&path).await;
                return Err(format!(
                    "下载中断（可能超时或连接被镜像断开）：{}",
                    describe_reqwest_error(&e)
                ));
            }
        };
        if let Err(e) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(format!("写入下载文件失败：{e}"));
        }
        received += chunk.len() as u64;
        let percent = if total > 0 {
            ((received as f64 / total as f64) * 100.0) as u32
        } else {
            0
        };
        let _ = app.emit(
            "update-download-progress",
            json!({ "fileName": safe_name, "received": received, "total": total, "percent": percent }),
        );
    }
    if total > 0 && received != total {
        drop(file);
        let _ = tokio::fs::remove_file(&path).await;
        return Err(format!("下载不完整：已收到 {received}/{total} 字节"));
    }
    let _ = file.flush().await;
    let _ = app.emit(
        "update-download-done",
        json!({ "fileName": safe_name, "path": path.to_string_lossy() }),
    );
    Ok(())
}

/// 打开已下载的安装包：macOS 挂载 DMG，Windows 启动 EXE 安装程序
#[tauri::command]
pub async fn open_installer(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err("安装包文件不存在".to_string());
    }
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    if cfg!(target_os = "windows") && !ext.eq_ignore_ascii_case("exe") {
        return Err("非法安装包格式（仅支持 .exe）".to_string());
    }
    if cfg!(target_os = "macos") && !ext.eq_ignore_ascii_case("dmg") {
        return Err("非法安装包格式（仅支持 .dmg）".to_string());
    }
    open_with_system(&path)
}

/// 用系统默认方式打开外部链接（Release 下载页等）
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    let raw = validate_external_url(&url)?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(raw)
            .spawn()
            .map_err(|e| format!("打开链接失败：{e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        // 避免使用 cmd /C start 防止 shell 参数注入；调用 explorer 更安全
        std::process::Command::new("explorer")
            .arg(raw)
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
        // /UPDATE 让 NSIS 走覆盖安装，不卸载旧版，保留安装目录下的 data/downloads
        std::process::Command::new(path)
            .arg("/UPDATE")
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

    /// 下载安装包必须使用独立的长超时，不能再退回版本检查的 20 秒。
    #[test]
    fn download_timeout_allows_large_installers() {
        assert!(DOWNLOAD_TIMEOUT_SECS > CHECK_TIMEOUT_SECS);
        assert!(DOWNLOAD_TIMEOUT_SECS >= 10 * 60);
        assert!(DOWNLOAD_CONNECT_TIMEOUT_SECS < DOWNLOAD_TIMEOUT_SECS);
    }

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

    #[test]
    fn apply_mirror_prefixes_or_passes_through() {
        // 直连：None 与空串都原样返回
        assert_eq!(
            apply_mirror("https://api.github.com/x", None).unwrap(),
            "https://api.github.com/x"
        );
        assert_eq!(
            apply_mirror("https://api.github.com/x", Some("  ")).unwrap(),
            "https://api.github.com/x"
        );
        // 镜像：前缀拼接并补末尾斜杠
        assert_eq!(
            apply_mirror("https://api.github.com/x", Some("https://gh-proxy.com")).unwrap(),
            "https://gh-proxy.com/https://api.github.com/x"
        );
        assert_eq!(
            apply_mirror("https://a.b/f", Some("https://m.example.com/sub/")).unwrap(),
            "https://m.example.com/sub/https://a.b/f"
        );
        // 非法镜像基址直接报错，不拼出坏 URL
        assert!(apply_mirror("https://api.github.com/x", Some("ftp://m.example.com")).is_err());
    }

    #[test]
    fn normalize_mirror_base_validates_scheme() {
        assert_eq!(
            normalize_mirror_base("https://gh-proxy.com").unwrap(),
            "https://gh-proxy.com/"
        );
        assert_eq!(
            normalize_mirror_base("https://gh-proxy.com/").unwrap(),
            "https://gh-proxy.com/"
        );
        assert!(normalize_mirror_base("").is_err());
        assert!(normalize_mirror_base("gh-proxy.com").is_err());
        assert!(normalize_mirror_base("socks5://127.0.0.1:1080").is_err());
    }

    /// 候选顺序：所选镜像优先，其余内置镜像补齐，直连兜底且不重复。
    #[test]
    fn update_candidates_order_and_dedup() {
        // 直连模式：直连优先，镜像作为兜底
        let none = update_candidates(None);
        assert_eq!(none.len(), 3);
        assert!(none[0].is_none(), "direct mode must try direct first");
        assert_eq!(none[1].as_deref(), Some("https://gh-proxy.com/"));
        assert_eq!(none[2].as_deref(), Some("https://gh-proxy.org/"));

        // 镜像模式：所选镜像优先，直连最后
        let gh = update_candidates(Some("https://gh-proxy.com"));
        assert_eq!(gh.len(), 3, "selected mirror must not be duplicated");
        assert_eq!(gh[0].as_deref(), Some("https://gh-proxy.com/"));
        assert_eq!(gh[1].as_deref(), Some("https://gh-proxy.org/"));
        assert!(gh[2].is_none());

        let org = update_candidates(Some("https://gh-proxy.org/"));
        assert_eq!(org[0].as_deref(), Some("https://gh-proxy.org/"));
        assert_eq!(org[1].as_deref(), Some("https://gh-proxy.com/"));

        let custom = update_candidates(Some("https://mirror.example.com/"));
        assert_eq!(custom[0].as_deref(), Some("https://mirror.example.com/"));
        assert_eq!(custom.len(), 4);
        assert!(custom.last().unwrap().is_none());
    }

    #[test]
    fn validate_external_url_checks_scheme_and_whitespace() {
        assert!(validate_external_url("https://github.com/moonlitxy/Termix").is_ok());
        assert!(validate_external_url("http://localhost:8080").is_ok());
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("cmd.exe /c calc").is_err());
        assert!(validate_external_url("https://example.com/path with spaces").is_err());
    }

    #[test]
    fn sanitize_installer_name_blocks_traversal_and_bad_extensions() {
        assert_eq!(
            sanitize_installer_name("Termix_1.0.5_x64-setup.exe").unwrap(),
            "Termix_1.0.5_x64-setup.exe"
        );
        assert_eq!(
            sanitize_installer_name("Termix_1.0.5_aarch64.dmg").unwrap(),
            "Termix_1.0.5_aarch64.dmg"
        );
        assert!(sanitize_installer_name("../../../evil.exe").is_err());
        assert!(sanitize_installer_name("foo/bar.exe").is_err());
        assert!(sanitize_installer_name("setup.bat").is_err());
        assert!(sanitize_installer_name("payload.sh").is_err());
    }
}
