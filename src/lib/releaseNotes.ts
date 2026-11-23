/**
 * 更新说明解析：把 GitHub Release 的 Markdown 正文拆成可渲染的块。
 * 只支持发布说明常用的标题、列表、段落和内联格式，避免引入完整 Markdown 依赖。
 */

export type ReleaseNoteBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "bullet"; text: string }
  | { type: "ordered"; number: number; text: string }
  | { type: "paragraph"; text: string };

export type InlineNoteToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const ORDERED_RE = /^(\d+)\.\s+(.*)$/;
const RULE_RE = /^-{3,}$/;
const INLINE_RE =
  /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>()]+)/g;
const MARKDOWN_LINK_RE = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/;

/** 解析发布说明正文为块级结构 */
export function parseReleaseNotes(raw: string): ReleaseNoteBlock[] {
  const blocks: ReleaseNoteBlock[] = [];
  const paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ type: "paragraph", text });
    paragraph.length = 0;
  };

  for (const line of (raw ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const text = line.trim();
    if (!text) {
      flushParagraph();
      continue;
    }
    if (text.startsWith("<!--") || RULE_RE.test(text)) {
      flushParagraph();
      continue;
    }

    const heading = HEADING_RE.exec(text);
    if (heading) {
      flushParagraph();
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: heading[2].trim() });
      continue;
    }

    const bullet = BULLET_RE.exec(text);
    if (bullet) {
      flushParagraph();
      blocks.push({ type: "bullet", text: bullet[1].trim() });
      continue;
    }

    const ordered = ORDERED_RE.exec(text);
    if (ordered) {
      flushParagraph();
      blocks.push({
        type: "ordered",
        number: Number(ordered[1]),
        text: ordered[2].trim(),
      });
      continue;
    }

    paragraph.push(text);
  }

  flushParagraph();
  return blocks;
}

/** 解析一行中的粗体、行内代码、Markdown 链接和裸链接 */
export function parseInlineReleaseNotes(text: string): InlineNoteToken[] {
  const tokens: InlineNoteToken[] = [];
  let lastIndex = 0;
  INLINE_RE.lastIndex = 0;

  for (let match = INLINE_RE.exec(text); match; match = INLINE_RE.exec(text)) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }

    const raw = match[0];
    if (raw.startsWith("**") && raw.endsWith("**")) {
      tokens.push({ type: "bold", text: raw.slice(2, -2) });
    } else if (raw.startsWith("`") && raw.endsWith("`")) {
      tokens.push({ type: "code", text: raw.slice(1, -1) });
    } else {
      const link = MARKDOWN_LINK_RE.exec(raw);
      if (link) {
        tokens.push({ type: "link", text: link[1], href: link[2] });
      } else if (raw.startsWith("http://") || raw.startsWith("https://")) {
        const trimmed = raw.replace(/[),.;:!?，。；：！？、]+$/, "");
        tokens.push({ type: "link", text: trimmed, href: trimmed });
        if (trimmed.length < raw.length) {
          tokens.push({ type: "text", text: raw.slice(trimmed.length) });
        }
      } else {
        tokens.push({ type: "text", text: raw });
      }
    }

    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: "text", text: text.slice(lastIndex) });
  }
  return tokens;
}
