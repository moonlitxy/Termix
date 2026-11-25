import { describe, expect, it } from "vitest";
import {
  extractCdFromLine,
  findLastCdCommand,
  normalizeRemotePath,
  parseCdIntent,
  resolveCdTarget,
} from "../cdPath";

describe("cd 路径解析", () => {
  it("识别 cd / pushd 目标", () => {
    expect(parseCdIntent("cd /var/log")).toEqual({
      target: "/var/log",
      needsHome: false,
    });
    expect(parseCdIntent("pushd ../opt")).toEqual({
      target: "../opt",
      needsHome: false,
    });
    expect(parseCdIntent("builtin cd /tmp")).toEqual({
      target: "/tmp",
      needsHome: false,
    });
  });

  it("处理无参数、~ 和带引号的路径", () => {
    expect(parseCdIntent("cd")).toEqual({ target: "", needsHome: true });
    expect(parseCdIntent("cd ~/work")).toEqual({
      target: "~/work",
      needsHome: true,
    });
    expect(parseCdIntent('cd "my project"')).toEqual({
      target: "my project",
      needsHome: false,
    });
  });

  it("跳过无法可靠推导的命令", () => {
    expect(parseCdIntent("ls -la")).toBeNull();
    expect(parseCdIntent("popd")).toBeNull();
    expect(parseCdIntent("pushd")).toBeNull();
    expect(parseCdIntent("cd -")).toBeNull();
    expect(parseCdIntent("cd $HOME")).toBeNull();
    expect(parseCdIntent("cd ~other")).toBeNull();
    expect(parseCdIntent("cd foo | tee")).toBeNull();
    expect(parseCdIntent("cd foo & ls")).toBeNull();
    expect(parseCdIntent("cd foo && cd bar")).toBeNull();
  });

  it("允许 cd 后接不会再次切换目录的命令", () => {
    expect(parseCdIntent("cd foo && ls -la")).toEqual({
      target: "foo",
      needsHome: false,
    });
    expect(parseCdIntent("cd '/opt/my app'; pwd")).toEqual({
      target: "/opt/my app",
      needsHome: false,
    });
    expect(parseCdIntent("cd /opt/app|| echo missing")).toEqual({
      target: "/opt/app",
      needsHome: false,
    });
  });

  it("相对路径基于当前远程目录，~ 基于 SFTP 家目录", () => {
    expect(
      resolveCdTarget(
        { target: "../etc", needsHome: false },
        "/home/user/app",
        "/home/user"
      )
    ).toBe("/home/user/app/../etc");
    expect(
      resolveCdTarget({ target: "~", needsHome: true }, "/tmp", "/home/user")
    ).toBe("/home/user");
    expect(
      resolveCdTarget(
        { target: "~/work", needsHome: true },
        "/tmp",
        "/home/user"
      )
    ).toBe("/home/user/work");
    expect(
      resolveCdTarget(
        { target: "/var/log", needsHome: false },
        "/tmp",
        ""
      )
    ).toBe("/var/log");
  });

  it("多行输入取最后一条 cd", () => {
    expect(findLastCdCommand("pwd\ncd /opt/app\nls -la")).toBe("cd /opt/app");
    expect(findLastCdCommand("cd /opt/app && ls -la")).toBe("cd /opt/app && ls -la");
    expect(findLastCdCommand("cd /a\ncd ../b")).toBe("cd ../b");
    expect(findLastCdCommand("cd /a\rcd ../b")).toBe("cd ../b");
    expect(findLastCdCommand("cd /a\ncd $HOME")).toBeNull();
    expect(findLastCdCommand("cd /a\ncd /b && cd /c")).toBeNull();
    expect(findLastCdCommand("ls -la")).toBeNull();
  });

  it("回退路径做纯词法规范化", () => {
    expect(normalizeRemotePath("/home/user/../etc")).toBe("/home/etc");
    expect(normalizeRemotePath("//home//user/./app")).toBe("/home/user/app");
    expect(normalizeRemotePath("/")).toBe("/");
  });

  it("从任意提示符行提取 cd", () => {
    expect(extractCdFromLine("➜  project git:(main) cd /opt/app")).toBe(
      "cd /opt/app"
    );
    expect(extractCdFromLine("root@host:/tmp$ cd ../log")).toBe("cd ../log");
    expect(extractCdFromLine("➜  project ls -la")).toBeNull();
  });
});
