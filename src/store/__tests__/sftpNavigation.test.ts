import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { ipc } from "../../lib/ipc";
import { useApp } from "../app";
import type { SftpItem } from "../../types";

const fastItems: SftpItem[] = [
  { name: "a", path: "/tmp/a", isDir: true, size: 4096, mtime: 1 },
  { name: "f.log", path: "/tmp/f.log", isDir: false, size: 12, mtime: 2 },
];
const enrichedItems: SftpItem[] = [
  { name: "a", path: "/tmp/a", isDir: true, size: 987654, mtime: 1 },
  { name: "f.log", path: "/tmp/f.log", isDir: false, size: 12, mtime: 2 },
];

describe("SFTP 页面交互：单击选中与双击进入", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "sftp_list") return fastItems;
      // 后台补充刻意延迟，模拟 du 耗时：首屏必须不等它就展示快速列表
      if (cmd === "sftp_list_enriched") {
        await new Promise((r) => setTimeout(r, 50));
        return enrichedItems;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    useApp.setState({
      sftpContext: { sessionId: "sess-1", connectionId: "conn-nav-1" },
      remotePath: "/tmp",
      remoteItems: [],
      remoteCache: {},
      remoteLoading: false,
      remoteError: null,
      remoteSelected: null,
    });
  });

  it("快速列表走 sftp_list，后台补充走 sftp_list_enriched", async () => {
    await expect(ipc.sftpList("c", "/tmp")).resolves.toEqual(fastItems);
    expect(mocks.invoke).toHaveBeenLastCalledWith("sftp_list", {
      connectionId: "c",
      path: "/tmp",
    });
    await expect(ipc.sftpEnrich("c", "/tmp")).resolves.toEqual(enrichedItems);
    expect(mocks.invoke).toHaveBeenLastCalledWith("sftp_list_enriched", {
      connectionId: "c",
      path: "/tmp",
    });
  });

  it("首屏先展示快速列表；单击只选中不跳目录；双击目录才进入", async () => {
    const st = useApp.getState();
    await st.loadRemote();
    // 首屏用快速结果直接展示，不等后台 du 完成（enrich 延迟 50ms）
    expect(useApp.getState().remoteItems).toEqual(fastItems);
    expect(useApp.getState().remoteLoading).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("sftp_list", {
      connectionId: "conn-nav-1",
      path: "/tmp",
    });
    // 后台补充完成后合并目录大小，不阻塞首屏
    await new Promise((r) => setTimeout(r, 80));
    expect(useApp.getState().remoteItems).toEqual(enrichedItems);

    // 单击文件夹：只选中，目录不变（列表不下移、不误触）
    useApp.getState().selectRemote(fastItems[0]);
    expect(useApp.getState().remotePath).toBe("/tmp");
    expect(useApp.getState().remoteSelected).toEqual(fastItems[0]);

    // 双击文件夹：进入该目录
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "sftp_list") return [];
      if (cmd === "sftp_list_enriched") return [];
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    await useApp.getState().openRemoteDir(fastItems[0]);
    expect(useApp.getState().remotePath).toBe("/tmp/a");
  });
});
