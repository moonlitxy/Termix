import { useEffect, useRef, useState, type ReactNode } from "react";
import { ipc } from "../lib/ipc";
import { useT } from "../lib/i18n";
import {
  parseInlineReleaseNotes,
  parseReleaseNotes,
  type ReleaseNoteBlock,
} from "../lib/releaseNotes";

interface ReleaseNotesProps {
  notes: string;
  emptyText?: string;
  collapsedHeight?: number;
  className?: string;
}

/** 更新说明：短内容直接展示，长内容默认折叠并可展开 */
export function ReleaseNotes({
  notes,
  emptyText,
  collapsedHeight = 220,
  className = "",
}: ReleaseNotesProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const blocks = parseReleaseNotes(notes);
  const hasNotes = blocks.length > 0;

  useEffect(() => {
    setExpanded(false);
  }, [notes]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !hasNotes) {
      setOverflow(false);
      return;
    }

    const measure = () => {
      if (!expanded) setOverflow(body.scrollHeight > collapsedHeight + 4);
    };
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [notes, expanded, collapsedHeight, hasNotes]);

  if (!hasNotes) {
    return (
      <div className={`release-notes release-notes--empty ${className}`.trim()}>
        {emptyText ?? t("update.noNotes")}
      </div>
    );
  }

  return (
    <div className={`release-notes ${expanded ? "is-expanded" : ""} ${className}`.trim()}>
      <div
        className="release-notes__viewport"
        style={expanded ? undefined : { maxHeight: `${collapsedHeight}px` }}
      >
        <div ref={bodyRef} className="release-notes__body">
          {blocks.map((block, index) => renderBlock(block, index))}
        </div>
        {!expanded && overflow && <div className="release-notes__fade" aria-hidden="true" />}
      </div>
      {overflow && (
        <button
          type="button"
          className="release-notes__toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("update.collapse") : t("update.expand")}
        </button>
      )}
    </div>
  );
}

function renderBlock(block: ReleaseNoteBlock, key: number): ReactNode {
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level}` as "h1" | "h2" | "h3";
      return (
        <Tag
          key={key}
          className={`release-notes__heading release-notes__heading--${block.level}`}
        >
          {renderInline(block.text)}
        </Tag>
      );
    }
    case "bullet":
      return (
        <div key={key} className="release-notes__item">
          <span className="release-notes__marker" aria-hidden="true">
            •
          </span>
          <span>{renderInline(block.text)}</span>
        </div>
      );
    case "ordered":
      return (
        <div key={key} className="release-notes__item">
          <span className="release-notes__marker" aria-hidden="true">
            {block.number}.
          </span>
          <span>{renderInline(block.text)}</span>
        </div>
      );
    default:
      return (
        <p key={key} className="release-notes__paragraph">
          {renderInline(block.text)}
        </p>
      );
  }
}

function renderInline(text: string): ReactNode[] {
  return parseInlineReleaseNotes(text).map((token, index) => {
    if (token.type === "bold") return <strong key={index}>{token.text}</strong>;
    if (token.type === "code") return <code key={index}>{token.text}</code>;
    if (token.type === "link") {
      const href = token.href;
      return (
        <a
          key={index}
          href={href}
          onClick={(event) => {
            event.preventDefault();
            void ipc.openExternal(href).catch(() => {
              window.open(href, "_blank", "noopener,noreferrer");
            });
          }}
        >
          {token.text}
        </a>
      );
    }
    return <span key={index}>{token.text}</span>;
  });
}
