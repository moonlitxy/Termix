import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  HISTORY_CHANGED_EVENT,
  ipc,
  onConnectionStatus,
  onTerminalOutput,
  onTransferProgress,
  onUpdateDownloadDone,
  onUpdateDownloadError,
  onUpdateDownloadProgress,
} from "../ipc";

describe("ipc command wrappers", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
  });

  it("所有命令都转发到 Tauri invoke", () => {
    const calls: Array<[keyof typeof ipc, unknown[]]> = [
      ["sessionList", []],
      ["sessionCreate", [{ name: "test" }]],
      ["sessionUpdate", ["id", { name: "test" }]],
      ["sessionMove", ["id", null]],
      ["sessionDelete", ["id"]],
      ["sessionsExport", []],
      ["sessionsImport", ["{}"]],
      ["groupList", []],
      ["groupCreate", [{ name: "g" }]],
      ["groupDelete", ["id"]],
      ["sessionConnect", ["id"]],
      ["sessionDisconnect", ["conn"]],
      ["hostKeyAccept", ["host", 22, "SHA256:x"]],
      ["terminalCreate", ["conn", "tab", 80, 24]],
      ["terminalWrite", ["conn", "shell", "ls"]],
      ["terminalResize", ["conn", "shell", 80, 24]],
      ["terminalDestroy", ["conn", "shell"]],
      ["historyList", ["session"]],
      ["historyAdd", ["session", "ls"]],
      ["historyClear", ["session"]],
      ["sftpList", ["conn", "/"]],
      ["sftpEnrich", ["conn", "/"]],
      ["sftpCwd", ["conn"]],
      ["sftpMkdir", ["conn", "/tmp"]],
      ["sftpCreateFile", ["conn", "/tmp/f"]],
      ["sftpRemove", ["conn", "/tmp/f", false]],
      ["sftpRename", ["conn", "/a", "/b"]],
      ["sftpChmod", ["conn", "/a", 0o644]],
      ["sftpUpload", ["conn", "session", "/a", "/b"]],
      ["sftpDownload", ["conn", "session", "/a", "/b"]],
      ["sftpUploadDir", ["conn", "session", "/a", "/b"]],
      ["sftpDownloadDir", ["conn", "session", "/a", "/b"]],
      ["transferList", []],
      ["transferCancel", ["task"]],
      ["transferPause", ["task"]],
      ["transferResume", ["task"]],
      ["localList", ["/tmp"]],
      ["localHome", []],
      ["localMkdir", ["/tmp"]],
      ["localRename", ["/a", "/b"]],
      ["localDelete", ["/a", false]],
      ["localOpenPath", ["/a"]],
      ["snippetList", []],
      ["snippetCreate", [{ title: "t" }]],
      ["snippetUpdate", ["id", { title: "t" }]],
      ["snippetDelete", ["id"]],
      ["forwardList", []],
      ["forwardCreate", [{ name: "f" }]],
      ["forwardUpdate", ["id", { name: "f" }]],
      ["forwardDelete", ["id"]],
      ["forwardStart", ["id"]],
      ["forwardStop", ["id"]],
      ["monitorMetrics", ["conn"]],
      ["monitorProcesses", ["conn"]],
      ["systemInfo", ["conn"]],
      ["masterStatus", []],
      ["masterSet", ["new"]],
      ["masterUnlock", ["pass"]],
      ["masterLock", []],
      ["masterClear", ["pass"]],
      ["checkUpdate", [null, null]],
      ["downloadUpdate", ["url", "file", null]],
      ["authRespond", ["auth-1", ["code"]]],
      ["authCancel", ["auth-1"]],
      ["sshConfigReadDefault", []],
      ["sshConfigImport", ["Host a\n  HostName 1.2.3.4\n"]],
      ["backupList", []],
      ["backupRestore", ["sessions-1-auto.json"]],
      ["backupNow", []],
      ["openInstaller", ["/tmp/file"]],
      ["openExternal", ["https://example.com"]],
    ];

    for (const [name, args] of calls) {
      (ipc[name] as unknown as (...values: unknown[]) => unknown)(...args);
    }

    expect(mocks.invoke).toHaveBeenCalledTimes(calls.length);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(
      expect.arrayContaining([
        "session_list",
        "session_move",
        "sftp_list",
        "sftp_list_enriched",
        "master_status",
        "check_update",
      ])
    );
  });

  it("事件监听封装传递载荷并返回 unlisten", async () => {
    mocks.listen.mockResolvedValue(() => {});
    const events: Array<
      [(cb: (payload: any) => void) => Promise<() => void>, string, unknown]
    > = [
      [onTerminalOutput, "terminal-output", { shellId: "s", data: "x", tabId: "t" }],
      [onConnectionStatus, "connection-status", { shellId: "s", tabId: "t", status: "closed" }],
      [onTransferProgress, "transfer-progress", { taskId: "id" }],
      [onUpdateDownloadProgress, "update-download-progress", { downloaded: 1 }],
      [onUpdateDownloadDone, "update-download-done", { fileName: "f", path: "/f" }],
      [onUpdateDownloadError, "update-download-error", { error: "x" }],
    ];

    for (const [register, eventName, payload] of events) {
      const callback = vi.fn();
      mocks.listen.mockClear();
      const result = await register(callback);
      expect(mocks.listen).toHaveBeenCalledWith(eventName, expect.any(Function));
      const handler = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => void;
      handler({ payload });
      expect(callback).toHaveBeenCalledWith(payload);
      expect(typeof result).toBe("function");
    }
    expect(HISTORY_CHANGED_EVENT).toBe("termix:history-changed");
  });
});
