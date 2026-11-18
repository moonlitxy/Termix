import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useFeedback } from "../store/feedback";
import { useFocusTrap } from "../lib/focusTrap";
import { useT } from "../lib/i18n";

const TOAST_ICON = {
  info: "info-circle",
  success: "check-circle",
  warning: "alert-triangle",
  error: "alert-circle",
} as const;

export function FeedbackHost() {
  const t = useT();
  const toasts = useFeedback((state) => state.toasts);
  const confirmRequest = useFeedback((state) => state.confirmRequest);
  const promptRequest = useFeedback((state) => state.promptRequest);
  const dismissToast = useFeedback((state) => state.dismissToast);
  const settleConfirm = useFeedback((state) => state.settleConfirm);
  const settlePrompt = useFeedback((state) => state.settlePrompt);

  const [promptValue, setPromptValue] = useState("");
  const promptInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const dialogOpen = !!confirmRequest || !!promptRequest;
  const dialogId = confirmRequest?.id ?? promptRequest?.id ?? 0;
  useFocusTrap(dialogRef, dialogOpen);

  const setDialogRef = (node: HTMLElement | null) => {
    dialogRef.current = node;
  };

  useEffect(() => {
    if (!promptRequest) return;
    setPromptValue(promptRequest.defaultValue ?? "");
    const frame = window.requestAnimationFrame(() => {
      promptInputRef.current?.focus();
      promptInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [promptRequest]);

  useEffect(() => {
    if (!dialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (confirmRequest) settleConfirm(false);
      if (promptRequest) settlePrompt(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dialogOpen, confirmRequest, promptRequest, settleConfirm, settlePrompt]);

  return (
    <>
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((item) => (
          <div
            className={`toast toast--${item.tone}`}
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
          >
            <span className="toast__icon">
              <Icon name={TOAST_ICON[item.tone]} size={16} />
            </span>
            <span className="toast__body">
              {item.title && <span className="toast__title">{item.title}</span>}
              <span className="toast__message">{item.message}</span>
            </span>
            <button
              className="toast__close"
              type="button"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={() => dismissToast(item.id)}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>

      {confirmRequest && (
        <div
          className="feedback-overlay"
          onMouseDown={() => settleConfirm(false)}
        >
          <div
            className="feedback-dialog"
            ref={setDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="feedback-confirm-title"
            aria-describedby="feedback-confirm-message"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="feedback-dialog__head">
              <span className="feedback-dialog__title" id="feedback-confirm-title">
                {confirmRequest.title ?? (confirmRequest.danger ? t("feedback.confirmDanger") : t("feedback.confirm"))}
              </span>
              <button
                className="dialog__close"
                type="button"
                title={t("common.close")}
                onClick={() => settleConfirm(false)}
              >
                <Icon name="x" size={15} />
              </button>
            </div>
            <div className="feedback-dialog__message" id="feedback-confirm-message">
              {confirmRequest.message}
            </div>
            <div className="feedback-dialog__actions">
              <button
                className="ds-btn ds-btn--secondary"
                type="button"
                autoFocus={confirmRequest.danger}
                onClick={() => settleConfirm(false)}
              >
                {confirmRequest.cancelText ?? t("common.cancel")}
              </button>
              <button
                className={
                  "ds-btn " +
                  (confirmRequest.danger ? "ds-btn--danger-subtle" : "ds-btn--brand")
                }
                type="button"
                autoFocus={!confirmRequest.danger}
                onClick={() => settleConfirm(true)}
              >
                {confirmRequest.confirmText ?? t("feedback.ok")}
              </button>
            </div>
          </div>
        </div>
      )}

      {promptRequest && (
        <div className="feedback-overlay" onMouseDown={() => settlePrompt(null)}>
          <form
            className="feedback-dialog"
            ref={setDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-prompt-title"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              settlePrompt(promptValue);
            }}
            key={dialogId}
          >
            <div className="feedback-dialog__head">
              <span className="feedback-dialog__title" id="feedback-prompt-title">
                {promptRequest.title}
              </span>
              <button
                className="dialog__close"
                type="button"
                title={t("common.close")}
                onClick={() => settlePrompt(null)}
              >
                <Icon name="x" size={15} />
              </button>
            </div>
            {promptRequest.message && (
              <div className="feedback-dialog__message">{promptRequest.message}</div>
            )}
            <div className="ds-input ds-input--block feedback-dialog__input">
              <input
                ref={promptInputRef}
                type="text"
                value={promptValue}
                placeholder={promptRequest.placeholder}
                onChange={(event) => setPromptValue(event.target.value)}
              />
            </div>
            <div className="feedback-dialog__actions">
              <button
                className="ds-btn ds-btn--secondary"
                type="button"
                onClick={() => settlePrompt(null)}
              >
                {promptRequest.cancelText ?? t("common.cancel")}
              </button>
              <button className="ds-btn ds-btn--brand" type="submit">
                {promptRequest.confirmText ?? t("feedback.ok")}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
