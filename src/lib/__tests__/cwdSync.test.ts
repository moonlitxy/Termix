import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sftpCwd: vi.fn(),
  sftpCanonicalDir: vi.fn(),
  sftpList: vi.fn(),
  sftpEnrich: vi.fn(),
}));

vi.mock("../ipc", () => ({
  ipc: {
    sftpCwd: mocks.sftpCwd,
    sftpCanonicalDir: mocks.sftpCanonicalDir,
    sftpList: mocks.sftpList,
    sftpEnrich: mocks.sftpEnrich,
  },
}));

import { useApp } from "../../store/app";

describe("终端 cwd 同步", () => {
  beforeEach(() => {
    mocks.sftpCwd.mockReset().mockResolvedValue("/home/user");
    mocks.sftpCanonicalDir.mockReset().mockResolvedValue("/opt/app");
    mocks.sftpList.mockReset().mockResolvedValue([]);
    mocks.sftpEnrich.mockReset().mockResolvedValue([]);
    useApp.setState({
      sftpContext: { sessionId: "s1", connectionId: "c1" },
      remotePath: "/home/user",
      remotePaths: {},
      remoteHomes: {},
      shellCwds: {},
      remoteCache: {},
      remoteItems: [],
      remoteLoading: false,
      remoteError: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("绝对路径 cd 更新面板并记录 shell cwd", async () => {
    await useApp.getState().syncRemoteCwd("cd /opt/app", "c1", "shell-1");
    expect(useApp.getState().remotePath).toBe("/opt/app");
    expect(useApp.getState().shellCwds["shell-1"]).toBe("/opt/app");
    expect(useApp.getState().remotePaths["c1"]).toBe("/opt/app");
  });

  it("相对路径基于该 shell 上次 cwd，而不是面板当前目录", async () => {
    useApp.setState({
      remotePath: "/var/log",
      shellCwds: { "shell-1": "/home/user" },
    });
    mocks.sftpCanonicalDir.mockResolvedValue("/home/etc");

    await useApp.getState().syncRemoteCwd("cd ../etc", "c1", "shell-1");

    expect(mocks.sftpCwd).not.toHaveBeenCalled();
    expect(mocks.sftpCanonicalDir).toHaveBeenCalledWith(
      "c1",
      "/home/user/../etc"
    );
    expect(useApp.getState().remotePath).toBe("/home/etc");
  });

  it("新后端命令不可用时回退到 sftp_list 校验", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.sftpCanonicalDir.mockRejectedValue("command not found");

    await useApp.getState().syncRemoteCwd("cd /tmp/../opt", "c1", "shell-1");

    expect(mocks.sftpList).toHaveBeenCalledWith("c1", "/tmp/../opt");
    expect(useApp.getState().remotePath).toBe("/opt");
  });

  it("目标目录与面板一致时仍记录 shell cwd，但不重复加载列表", async () => {
    useApp.setState({ remotePath: "/opt/app" });
    mocks.sftpCanonicalDir.mockResolvedValue("/data/opt-app");

    await useApp.getState().syncRemoteCwd("cd /opt/app", "c1", "shell-1");

    expect(useApp.getState().remotePath).toBe("/opt/app");
    expect(useApp.getState().shellCwds["shell-1"]).toBe("/opt/app");
    expect(mocks.sftpList).not.toHaveBeenCalled();
  });

  it("符号链接保留用户输入的逻辑路径，供后续 cd .. 使用", async () => {
    mocks.sftpCanonicalDir.mockResolvedValue("/data/html");

    await useApp.getState().syncRemoteCwd(
      "cd /var/www/html",
      "c1",
      "shell-1"
    );

    expect(useApp.getState().remotePath).toBe("/var/www/html");
    expect(useApp.getState().shellCwds["shell-1"]).toBe("/var/www/html");
  });

  it("旧请求晚返回时不会覆盖较新的目录", async () => {
    let resolveSlow: (value: string | null) => void = () => {};
    const slow = new Promise<string | null>((resolve) => {
      resolveSlow = resolve;
    });
    mocks.sftpCanonicalDir.mockImplementation(async (_connectionId, path) =>
      path === "/slow" ? slow : "/fast"
    );

    const first = useApp
      .getState()
      .syncRemoteCwd("cd /slow", "c1", "shell-race");
    const second = useApp
      .getState()
      .syncRemoteCwd("cd /fast", "c1", "shell-race");
    await second;

    resolveSlow("/slow");
    await first;

    expect(useApp.getState().remotePath).toBe("/fast");
    expect(useApp.getState().shellCwds["shell-race"]).toBe("/fast");
  });

  it("连接失效时保留 SFTP 绑定，等待重连后重新绑定", async () => {
    mocks.sftpList.mockRejectedValue("connection not found");

    await useApp.getState().syncRemoteCwd("cd /opt/app", "c1", "shell-1");

    expect(useApp.getState().sftpContext).toEqual({
      sessionId: "s1",
      connectionId: "c1",
    });
    expect(useApp.getState().remoteError).toContain("connection not found");
  });

  it("SFTP 面板属于其他连接时不误跳", async () => {
    useApp.setState({ sftpContext: { sessionId: "s2", connectionId: "c2" } });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await useApp.getState().syncRemoteCwd("cd /opt/app", "c1", "shell-1");

    expect(mocks.sftpCanonicalDir).not.toHaveBeenCalled();
    expect(useApp.getState().remotePath).toBe("/home/user");
  });
});
