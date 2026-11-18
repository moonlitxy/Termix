//! `~/.ssh/config` 导入解析：纯函数，无副作用，便于单元测试。
//!
//! 支持范围（够用且可预测）：
//! - `Host 别名...` 分块；别名含通配符（`*?!`）的条目跳过；
//! - 键名大小写不敏感：`HostName`、`User`、`Port`、`IdentityFile`（仅首个）；
//! - `Host *` 块的值作为后续块的默认值（User/Port/IdentityFile）；
//! - 无 `HostName` 时用别名本身作主机（与 OpenSSH 行为一致）；
//! - `#` 后视为注释截断（路径含 `#` 的极端情况不支持）。
//! - 不支持：`Match`、`Include`、`ProxyJump`（跳板请在应用内配置）。

#[derive(Debug, Clone, PartialEq)]
pub struct SshConfigHost {
    pub name: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: u16,
    pub identity_file: Option<String>,
}

fn is_pattern(s: &str) -> bool {
    s.contains(['*', '?', '!'])
}

fn strip_quotes(s: &str) -> &str {
    let s = s.trim();
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"'))
            || (s.starts_with('\'') && s.ends_with('\'')))
    {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// 解析 ssh config 全文，返回可导入的主机条目（按出现顺序）。
pub fn parse_ssh_config(content: &str) -> Vec<SshConfigHost> {
    #[derive(Default)]
    struct Pending {
        aliases: Vec<String>,
        hostname: Option<String>,
        user: Option<String>,
        port: Option<u16>,
        identity_file: Option<String>,
    }
    let mut defaults_user: Option<String> = None;
    let mut defaults_port: Option<u16> = None;
    let mut defaults_identity: Option<String> = None;
    let mut current: Option<Pending> = None;
    let mut out: Vec<SshConfigHost> = Vec::new();

    // 闭包：把累积块落盘（每个别名一条；通配符整块跳过）
    let flush = |block: Pending,
                     defaults_user: &Option<String>,
                     defaults_port: &Option<u16>,
                     defaults_identity: &Option<String>,
                     out: &mut Vec<SshConfigHost>| {
        // `Host *` 纯默认块：只记录默认值，不产生条目
        if block.aliases.iter().all(|a| a == "*") {
            return;
        }
        for alias in block.aliases.iter().filter(|a| !is_pattern(a)) {
            out.push(SshConfigHost {
                name: alias.clone(),
                hostname: block
                    .hostname
                    .clone()
                    .unwrap_or_else(|| alias.clone()),
                user: block.user.clone().or_else(|| defaults_user.clone()),
                port: block.port.or(*defaults_port).unwrap_or(22),
                identity_file: block
                    .identity_file
                    .clone()
                    .or_else(|| defaults_identity.clone()),
            });
        }
    };

    for raw in content.lines() {
        // 截断注释（值中带 # 的极端路径不支持）
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or("").to_ascii_lowercase();
        let rest: Vec<&str> = parts.collect();
        if key == "host" {
            if let Some(prev) = current.take() {
                // 上一块若是 `Host *` 则收敛为默认值
                if prev.aliases.iter().all(|a| a == "*") {
                    if prev.user.is_some() {
                        defaults_user = prev.user;
                    }
                    if prev.port.is_some() {
                        defaults_port = prev.port;
                    }
                    if prev.identity_file.is_some() {
                        defaults_identity = prev.identity_file;
                    }
                } else {
                    flush(prev, &defaults_user, &defaults_port, &defaults_identity, &mut out);
                }
            }
            current = Some(Pending {
                aliases: rest.iter().map(|s| s.to_string()).collect(),
                ..Default::default()
            });
            continue;
        }
        let Some(cur) = current.as_mut() else { continue };
        match key.as_str() {
            "hostname" => {
                if let Some(v) = rest.first() {
                    cur.hostname = Some(strip_quotes(v).to_string());
                }
            }
            "user" => {
                if let Some(v) = rest.first() {
                    cur.user = Some(v.to_string());
                }
            }
            "port" => {
                if let Some(v) = rest.first().and_then(|v| v.parse::<u16>().ok()) {
                    cur.port = Some(v);
                }
            }
            "identityfile" => {
                if cur.identity_file.is_none() {
                    if let Some(v) = rest.first() {
                        cur.identity_file = Some(strip_quotes(v).to_string());
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(prev) = current.take() {
        if prev.aliases.iter().all(|a| a == "*") {
            // 文件末尾的默认块：无后续块可应用，直接丢弃
        } else {
            flush(prev, &defaults_user, &defaults_port, &defaults_identity, &mut out);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_hosts() {
        let hosts = parse_ssh_config(
            "Host prod\n  HostName 10.0.0.1\n  User root\n  Port 2222\n  IdentityFile ~/.ssh/id_rsa\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "prod");
        assert_eq!(hosts[0].hostname, "10.0.0.1");
        assert_eq!(hosts[0].user.as_deref(), Some("root"));
        assert_eq!(hosts[0].port, 2222);
        assert_eq!(hosts[0].identity_file.as_deref(), Some("~/.ssh/id_rsa"));
    }

    #[test]
    fn hostname_defaults_to_alias_and_skips_patterns() {
        let hosts = parse_ssh_config("Host web\nHost *.internal\n  HostName x\nHost db backup\n  HostName 10.0.0.2\n");
        assert_eq!(hosts.len(), 3);
        assert_eq!(hosts[0].hostname, "web");
        assert_eq!(hosts[0].port, 22);
        assert_eq!(hosts[1].name, "db");
        assert_eq!(hosts[2].name, "backup");
    }

    #[test]
    fn host_star_provides_defaults_case_insensitive() {
        let hosts = parse_ssh_config(
            "HOST *\n  user deploy\n  port 2200\nHost app\n  hostname 10.1.1.1\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
        assert_eq!(hosts[0].port, 2200);
        // 块内显式值覆盖默认
        let hosts = parse_ssh_config("Host *\n  Port 2200\nHost app\n  HostName h\n  Port 22\n");
        assert_eq!(hosts[0].port, 22);
    }

    #[test]
    fn comments_and_empty_lines_ignored() {
        let hosts = parse_ssh_config("# 注释\n\nHost a # 行尾注释\n  #HostName 9.9.9.9\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].hostname, "a");
    }

    /// Windows 导出的 config 常带 CRLF、制表符缩进与引号包裹的路径。
    #[test]
    fn crlf_tabs_and_quoted_identity_file() {
        let hosts = parse_ssh_config(
            "Host prod backup\r\n\tHostName \"10.0.0.5\"\r\n\tUser\tdeploy\r\n\tPort 2222\r\n\tIdentityFile \"C:\\Users\\me\\.ssh\\id_ed25519\"\r\n",
        );
        assert_eq!(hosts.len(), 2);
        for h in &hosts {
            assert_eq!(h.hostname, "10.0.0.5");
            assert_eq!(h.user.as_deref(), Some("deploy"));
            assert_eq!(h.port, 2222);
            assert_eq!(
                h.identity_file.as_deref(),
                Some("C:\\Users\\me\\.ssh\\id_ed25519")
            );
        }
        assert_eq!(hosts[0].name, "prod");
        assert_eq!(hosts[1].name, "backup");
    }
}
