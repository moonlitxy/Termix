# 发版签名与公证配置

> 目标：macOS DMG 双击即装（无“无法验证开发者”拦截），Windows EXE 有签名者信息。
> 代码侧已就绪（workflow 自动判断 secrets 是否存在）；下面只需总裁准备证书并填 6 个 secrets。

## 一、Apple Developer（macOS 签名 + 公证）

1. 在 [Apple Developer](https://developer.apple.com)  enrolled 账号（年费个人/公司均可）：
   - Certificates → 新建 **Developer ID Application** 证书，下载 `.cer`，双击装入本机钥匙串。
   - 在钥匙串中找到该证书（含私钥）→ 右键导出 `.p12`，设一个导出密码。
2. 生成 App 专用密码：在 [appleid.apple.com](https://appleid.apple.com) → 登录 Apple ID → App 专用密码 → 新建一个（如 `Termix-notarize`）。
3. 仓库 Settings → Secrets → Actions 新增：
   | Secret | 内容 |
   |---|---|
   | `APPLE_CERTIFICATE` | `.p12` 文件 base64（`base64 -i cert.p12 \| pbcopy`） |
   | `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 |
   | `APPLE_SIGNING_IDENTITY` | 形如 `Developer ID Application: XXX (TEAMID)` |
   | `APPLE_ID` | 你的 Apple ID 邮箱 |
   | `APPLE_PASSWORD` | 上面的 App 专用密码 |
   | `APPLE_TEAM_ID` | 10 位 Team ID（Developer 后台 Membership 可见） |
4. 下次推送 `v*` tag 即自动签名 + 公证 + 装订。
   workflow 不依赖第三方证书导入 action：Tauri CLI 自带临时钥匙串导入，
   secrets 齐全时自动签名公证；`APPLE_SIGNING_IDENTITY` 存在时会额外跑
   `xcrun stapler validate` 校验公证票据，票据缺失则发版失败。

验证（任选其一）：

```bash
scripts/verify-macos-signature.sh src-tauri/target/release/bundle/dmg/Termix_*.dmg
# 两条都打 ✅ 才算可发布；未签名包会返回 rejected / no ticket
```

> 实测记录（2026-11-18，本机无证书构建）：DMG 可正常产出（8.8MB），
> 但 `spctl` 返回 `rejected: no usable signature`、`stapler` 报无票据——
> 即未配置 secrets 时 Gatekeeper 会拦截，必须完成上面的配置。

## 二、Windows Authenticode（可选）

1. 购买 OV/EV 代码签名证书（EV 自带 USBKey，CI 无法使用；CI 场景选可导出私钥的 OV）。
2. 导出 `.pfx`，转 base64 后填入 secrets：
   | Secret | 内容 |
   |---|---|
   | `WINDOWS_CERTIFICATE` | `.pfx` 文件 base64 |
   | `WINDOWS_CERTIFICATE_PASSWORD` | 导出密码 |
3. 无证书也可发版：workflow 自动跳过，Windows SmartScreen 会提示未知发布者，不影响安装。

## 三、本地验证签名是否生效

- macOS：`codesign -dv --verbose=4 /Applications/Termix.app` 查看 Authority 是否为你的 Developer ID。
- Windows：右键 EXE → 属性 → 数字签名 → 应列出你的公司名称。
