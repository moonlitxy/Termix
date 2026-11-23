import { describe, expect, it } from "vitest";
import { parseInlineReleaseNotes, parseReleaseNotes } from "../releaseNotes";

describe("releaseNotes 解析", () => {
  it("拆分标题、列表和段落", () => {
    const blocks = parseReleaseNotes(
      [
        "## 修复内容",
        "",
        "- 下载超时改为 30 分钟",
        "- 清理半成品文件",
        "",
        "1. 先退出应用",
        "2. 再覆盖安装",
        "",
        "普通说明文字。",
      ].join("\n")
    );

    expect(blocks).toEqual([
      { type: "heading", level: 2, text: "修复内容" },
      { type: "bullet", text: "下载超时改为 30 分钟" },
      { type: "bullet", text: "清理半成品文件" },
      { type: "ordered", number: 1, text: "先退出应用" },
      { type: "ordered", number: 2, text: "再覆盖安装" },
      { type: "paragraph", text: "普通说明文字。" },
    ]);
  });

  it("空内容和分隔线不产生空块", () => {
    expect(parseReleaseNotes("")).toEqual([]);
    expect(parseReleaseNotes("\n---\n\n")).toEqual([]);
  });

  it("解析粗体、行内代码、Markdown 链接和裸链接", () => {
    expect(
      parseInlineReleaseNotes(
        "**发布说明**: 运行 `termix`，见 [Release](https://github.com/a/b) 或 https://example.com。"
      )
    ).toEqual([
      { type: "bold", text: "发布说明" },
      { type: "text", text: ": 运行 " },
      { type: "code", text: "termix" },
      { type: "text", text: "，见 " },
      { type: "link", text: "Release", href: "https://github.com/a/b" },
      { type: "text", text: " 或 " },
      { type: "link", text: "https://example.com", href: "https://example.com" },
      { type: "text", text: "。" },
    ]);
  });

  it("连续普通行合并为一个段落", () => {
    expect(parseReleaseNotes("第一行\n第二行\n\n第三段")).toEqual([
      { type: "paragraph", text: "第一行 第二行" },
      { type: "paragraph", text: "第三段" },
    ]);
  });
});
