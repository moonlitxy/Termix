import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { ipc, onAuthPrompt, type AuthPromptEvent } from "../lib/ipc";
import { useT } from "../lib/i18n";

/**
 * 键盘交互认证（2FA）全局提示宿主：
 * 后端 `auth-prompt` 事件到达时弹出模态框，用户逐项填写后调 `auth_respond`
 * 回填；取消则调 `auth_cancel`，连接随即失败并在终端显示原因。
 * 多个连接同时验证时按到达顺序排队展示。
 */
export function AuthPromptHost() {
  const t = useT();
  const [queue, setQueue] = useState<AuthPromptEvent[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let un: (() => void) | undefined;
    onAuthPrompt((e) => {
      setQueue((q) => (q.some((p) => p.authId === e.authId) ? q : [...q, e]));
    })
      .then((u) => {
        un = u;
      })
      .catch(() => {
        /* browser mode */
      });
    return () => {
      un?.();
    };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const dismiss = () => {
    setQueue((q) => q.slice(1));
    setValues({});
    setBusy(false);
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await ipc.authRespond(
        current.authId,
        current.prompts.map((_, i) => values[`${current.authId}:${i}`] ?? "")
      );
    } catch {
      /* 后端可能已超时清理，忽略 */
    }
    dismiss();
  };

  const cancel = async () => {
    try {
      await ipc.authCancel(current.authId);
    } catch {
      /* ignore */
    }
    dismiss();
  };

  return (
    <div className="dialog-overlay" onMouseDown={() => {}}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("auth.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog__header">
          <span className="dialog__title">
            <Icon name="key" size={15} />
            {t("auth.title")}：{current.name || t("auth.defaultName")}
          </span>
        </div>
        {current.instructions && (
          <div className="dialog__field">
            <div className="dialog__field-hint">{current.instructions}</div>
          </div>
        )}
        {current.prompts.map((p, i) => (
          <div className="dialog__field" key={i}>
            <label className="dialog__field-label">{p.text || t("auth.inputFallback", { n: i + 1 })}</label>
            <div className="ds-input ds-input--block">
              <input
                type={p.echo ? "text" : "password"}
                value={values[`${current.authId}:${i}`] ?? ""}
                autoFocus={i === 0}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [`${current.authId}:${i}`]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") void confirm();
                }}
              />
            </div>
          </div>
        ))}
        <div className="dialog__field">
          <div className="dialog__field-hint">{t("auth.timeoutHint")}</div>
        </div>
        <div className="dialog__actions">
          <button
            className="ds-btn ds-btn--secondary"
            type="button"
            disabled={busy}
            title={t("auth.cancelTitle")}
            onClick={() => void cancel()}
          >{t("common.cancel")}</button>
          <button
            className="ds-btn ds-btn--brand"
            type="button"
            disabled={busy}
            title={t("auth.submitTitle")}
            onClick={() => void confirm()}
          >{t("feedback.ok")}</button>
        </div>
      </div>
    </div>
  );
}
