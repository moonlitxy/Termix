import { describe, expect, it } from "vitest";
import { terminalBufferToText, terminalLogFileName } from "../terminalLog";

describe("terminalBufferToText", () => {
  it("拼接缓冲区并去掉尾部空行", () => {
    const lines = ["hello", "", "world", "", ""];
    const buffer = {
      length: lines.length,
      getLine: (index: number) => ({
        translateToString: () => lines[index],
      }),
    };
    expect(terminalBufferToText(buffer)).toBe("hello\n\nworld");
  });

  it("空缓冲区返回空字符串", () => {
    expect(
      terminalBufferToText({
        length: 0,
        getLine: () => undefined,
      })
    ).toBe("");
  });

  it("缺失的行按空行处理", () => {
    const buffer = {
      length: 2,
      getLine: (index: number) =>
        index === 0
          ? { translateToString: () => "hello" }
          : undefined,
    };
    expect(terminalBufferToText(buffer)).toBe("hello");
  });
});

describe("terminalLogFileName", () => {
  it("清理非法文件名字符并生成时间戳", () => {
    const now = new Date(2026, 0, 2, 3, 4, 5);
    expect(terminalLogFileName("prod/server:01", now)).toBe(
      "termix-prod_server_01-20260102-030405.log"
    );
  });

  it("空标题使用 terminal 默认名", () => {
    expect(terminalLogFileName("   ", new Date(2026, 0, 2, 3, 4, 5))).toBe(
      "termix-terminal-20260102-030405.log"
    );
  });
});
