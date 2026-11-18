import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { dirname, joinPath } from "../app";

describe("joinPath", () => {
  it("根目录拼接不产生双斜杠", () => {
    expect(joinPath("/", "var")).toBe("/var");
  });

  it("普通目录拼接加斜杠", () => {
    expect(joinPath("/opt/app", "log")).toBe("/opt/app/log");
  });

  it("空目录返回文件名本身", () => {
    expect(joinPath("", "a.txt")).toBe("a.txt");
  });
});

describe("dirname", () => {
  it("返回上级目录", () => {
    expect(dirname("/opt/app/log")).toBe("/opt/app");
  });

  it("根目录与顶层路径返回根目录", () => {
    expect(dirname("/")).toBe("/");
    expect(dirname("/tmp")).toBe("/");
  });
});
