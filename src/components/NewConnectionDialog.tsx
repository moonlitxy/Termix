import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import { useFocusTrap } from "../lib/focusTrap";
import { useT } from "../lib/i18n";
import { AUTH_METHODS, validateJumpSelection } from "../lib/sshAuth";
import type { AuthType, SessionInput } from "../types";

const EMPTY: SessionInput = {
  name: "",
  host: "",
  port: 22,
  username: "",
  authType: "password",
  password: "",
  privateKeyPath: "",
  privateKeyPassphrase: "",
  jumpSessionId: "",
  agentForward: false,
  groupId: "",
  memo: "",
  encoding: "utf-8",
};

export function NewConnectionDialog() {
  const t = useT();
  const open = useApp((s) => s.newConnOpen);
  const editing = useApp((s) => s.editingSession);
  const groups = useApp((s) => s.groups);
  const sessions = useApp((s) => s.sessions);
  const presetGroupId = useApp((s) => s.newConnPresetGroupId);
  const closeNewConnection = useApp((s) => s.closeNewConnection);
  const loadSessions = useApp((s) => s.loadSessions);
  const loadGroups = useApp((s) => s.loadGroups);

  const [form, setForm] = useState<SessionInput>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeNewConnection();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [open, closeNewConnection]);

  const isEnc = (s?: string) => !!s && s.startsWith("enc:v1:");

  useEffect(() => {
    if (!open) return;
    // 打开时刷新分组，确保能选择到最新创建的分组
    void loadGroups();
    if (editing) {
      setForm({
        name: editing.name,
        host: editing.host,
        port: editing.port,
        username: editing.username,
        authType: editing.authType,
        // 已加密的密码不回显，留空表示保持不变
        password: isEnc(editing.password) ? "" : (editing.password ?? ""),
        privateKeyPath: editing.privateKeyPath ?? "",
        privateKeyPassphrase: isEnc(editing.privateKeyPassphrase)
          ? ""
          : (editing.privateKeyPassphrase ?? ""),
        jumpSessionId: editing.jumpSessionId ?? "",
        agentForward: editing.agentForward ?? false,
        groupId: editing.groupId ?? "",
        memo: editing.memo ?? "",
        encoding: editing.encoding,
      });
    } else {
      // 从分组快捷入口打开时预选该分组
      setForm({ ...EMPTY, groupId: presetGroupId ?? "" });
    }
    setSaveError("");
  }, [open, editing, presetGroupId]);

  if (!open) return null;

  const set = <K extends keyof SessionInput>(key: K, val: SessionInput[K]) => {
    setForm((f) => ({ ...f, [key]: val }));
  };

  // 同一分组内连接名称唯一性校验（无分组视为同一组）
  const checkNameUnique = (name: string, groupId: string, excludeId?: string): string => {
    const n = name.trim();
    if (!n) return "";
    const dup = sessions.some(
      (s) =>
        s.name === n &&
        (s.groupId ?? "") === (groupId || "") &&
        s.id !== excludeId
    );
    return dup ? t("conn.dupName", { n }) : "";
  };

  const canSave =
    form.name.trim() && form.host.trim() && form.username.trim() && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    const nameErr = checkNameUnique(form.name, form.groupId ?? "", editing?.id);
    if (nameErr) {
      setSaveError(nameErr);
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const input: SessionInput = {
        ...form,
        port: Number(form.port) || 22,
        groupId: form.groupId || undefined,
        memo: form.memo || undefined,
        // 密码/私钥密码留空时保留原值（含密文），避免编辑其他字段时丢失密码
        password:
          form.authType === "password"
            ? form.password ||
              (editing && isEnc(editing.password) ? editing.password : undefined)
            : undefined,
        privateKeyPath: form.authType === "key" ? form.privateKeyPath : undefined,
        privateKeyPassphrase:
          form.authType === "key"
            ? form.privateKeyPassphrase ||
              (editing && isEnc(editing.privateKeyPassphrase)
                ? editing.privateKeyPassphrase
                : undefined)
            : undefined,
        jumpSessionId: form.jumpSessionId || undefined,
        agentForward: form.agentForward || undefined,
      };
      const jumpErr = validateJumpSelection(input.jumpSessionId, editing?.id, sessions);
      if (jumpErr) {
        setSaveError(jumpErr);
        setSaving(false);
        return;
      }
      if (editing) {
        await ipc.sessionUpdate(editing.id, input);
      } else {
        await ipc.sessionCreate(input);
      }
      await loadSessions();
      closeNewConnection();
    } catch (e) {
      // 后端校验失败（如名称唯一性冲突）时展示给用户
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-overlay" onMouseDown={closeNewConnection}>
      <div
        className="dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? t("conn.edit") : t("conn.new")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog__header">
          <span className="dialog__title">
            {editing ? t("conn.edit") : t("conn.new")}
          </span>
          <button
            className="dialog__close"
            type="button"
            onClick={closeNewConnection}
            title={t("common.close")}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="dialog__field">
          <label className="dialog__field-label">{t("conn.name")}<span className="dialog__required" aria-hidden="true">
              *
            </span>
          </label>
          <div className="ds-input ds-input--block">
            <input
              type="text"
              value={form.name}
              onChange={(e) => {
                set("name", e.target.value);
                if (saveError) setSaveError("");
              }}
              placeholder={t("conn.namePh")}
            />
          </div>
          {saveError && <div className="dialog__field-error">{saveError}</div>}
        </div>

        <div className="dialog__field-row">
          <div className="dialog__field">
            <label className="dialog__field-label">{t("conn.host")}<span className="dialog__required" aria-hidden="true">
                *
              </span>
            </label>
            <div className="ds-input ds-input--block">
              <input
                type="text"
                value={form.host}
                onChange={(e) => set("host", e.target.value)}
                placeholder={t("conn.hostPh")}
              />
            </div>
          </div>
          <div className="dialog__field" style={{ flex: "0 0 100px" }}>
            <label className="dialog__field-label">{t("conn.port")}</label>
            <div className="ds-input ds-input--block">
              <input
                type="number"
                value={form.port}
                onChange={(e) => set("port", Number(e.target.value))}
                min={1}
                max={65535}
              />
            </div>
          </div>
        </div>

        <div className="dialog__field">
          <label className="dialog__field-label">{t("conn.username")}<span className="dialog__required" aria-hidden="true">
              *
            </span>
          </label>
          <div className="ds-input ds-input--block">
            <span className="ds-input__icon">
              <Icon name="key" size={13} />
            </span>
            <input
              type="text"
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
              placeholder={t("conn.usernamePh")}
            />
          </div>
        </div>

        <div className="dialog__field">
          <label className="dialog__field-label">{t("conn.authMethod")}</label>
          <select
            className="ds-select ds-select--block"
            value={form.authType}
            onChange={(e) => set("authType", e.target.value as AuthType)}
          >
            {AUTH_METHODS.map((m) => (
              <option
                key={m.id}
                value={m.id}
                title={
                  m.id === "keyboard"
                    ? t("conn.keyboardHint")
                    : m.id === "agent"
                      ? t("conn.agentHint")
                      : t(`conn.authHint.${m.id}`)
                }
              >
                {t(`conn.auth.${m.id}`)}
              </option>
            ))}
          </select>
        </div>

        {form.authType === "password" ? (
          <div className="dialog__field">
            <label className="dialog__field-label">{t("conn.password")}</label>
            <div className="ds-input ds-input--block">
              <input
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder={t("conn.passwordPh")}
              />
              <button
                className="ds-input__action"
                type="button"
                title={showPassword ? t("conn.hidePassword") : t("conn.showPassword")}
                onClick={() => setShowPassword((v) => !v)}
              >
                <Icon name={showPassword ? "eye-off" : "eye"} size={13} />
              </button>
            </div>
          </div>
        ) : form.authType === "key" ? (
          <>
            <div className="dialog__field">
              <label className="dialog__field-label">{t("conn.keyPath")}</label>
              <div className="ds-input ds-input--block">
                <input
                  type="text"
                  value={form.privateKeyPath}
                  onChange={(e) => set("privateKeyPath", e.target.value)}
                  placeholder={t("conn.keyPathPh")}
                />
              </div>
            </div>
            <div className="dialog__field">
              <label className="dialog__field-label">{t("conn.keyPass")}</label>
              <div className="ds-input ds-input--block">
                <input
                  type={showPassphrase ? "text" : "password"}
                  value={form.privateKeyPassphrase}
                  onChange={(e) => set("privateKeyPassphrase", e.target.value)}
                  placeholder={t("conn.optional")}
                />
                <button
                  className="ds-input__action"
                  type="button"
                  title={showPassphrase ? t("conn.hidePassword") : t("conn.showPassword")}
                  onClick={() => setShowPassphrase((v) => !v)}
                >
                  <Icon name={showPassphrase ? "eye-off" : "eye"} size={13} />
                </button>
              </div>
            </div>
          </>
        ) : form.authType === "keyboard" ? (
          <div className="dialog__field">
            <div className="dialog__field-hint">{t("conn.keyboardHint")}</div>
          </div>
        ) : (
          <div className="dialog__field">
            <div className="dialog__field-hint">{t("conn.agentHint")}</div>
          </div>
        )}

        <div className="dialog__field">
          <label className="dialog__field-label">{t("conn.jump")}</label>
          <select
            className="ds-select ds-select--block"
            value={form.jumpSessionId}
            onChange={(e) => set("jumpSessionId", e.target.value)}
          >
            <option value="">{t("conn.jumpDirect")}</option>
            {sessions
              .filter((s) => !editing || s.id !== editing.id)
              .filter((s) => !s.jumpSessionId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{s.username}@{s.host}）
                </option>
              ))}
          </select>
        </div>

        <div className="dialog__field">
          <label className="dialog__check">
            <input
              type="checkbox"
              checked={!!form.agentForward}
              onChange={(e) => set("agentForward", e.target.checked)}
            />{t("conn.agentForward")}</label>
          <div className="dialog__field-hint">{t("conn.agentForwardHint")}</div>
        </div>

        <div className="dialog__field">
          <label className="dialog__field-label">{t("conn.group")}</label>
          <select
            className="ds-select ds-select--block"
            value={form.groupId}
            onChange={(e) => set("groupId", e.target.value)}
          >
            <option value="">{t("conn.noGroup")}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>

        <div className="dialog__field">
          <div className="dialog__field-label dialog__field-label--row">
            <span>{t("conn.memo")}</span>
            <span className="dialog__field-optional">{t("conn.optional")}</span>
          </div>
          <div className="ds-input ds-input--block ds-input--textarea">
            <textarea
              value={form.memo}
              onChange={(e) => set("memo", e.target.value)}
              placeholder={t("conn.memoPh")}
              rows={2}
            />
          </div>
        </div>

        <div className="dialog__actions">
          <button
            className="ds-btn ds-btn--secondary"
            type="button"
            title={t("conn.cancelTitle")}
            onClick={closeNewConnection}
          >{t("common.cancel")}</button>
          <button
            className="ds-btn ds-btn--brand"
            type="button"
            title={t("conn.saveTitle")}
            onClick={handleSave}
            disabled={!canSave}
          >
            {saving ? t("conn.saving") : t("conn.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
