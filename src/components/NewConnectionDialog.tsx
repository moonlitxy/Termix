import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
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
  groupId: "",
  memo: "",
  encoding: "utf-8",
};

export function NewConnectionDialog() {
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
    return dup ? `同一分组下已存在名为「${n}」的连接` : "";
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
      };
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
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog__header">
          <span className="dialog__title">
            {editing ? "编辑连接" : "新建连接"}
          </span>
          <button
            className="dialog__close"
            type="button"
            onClick={closeNewConnection}
            title="关闭"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="dialog__field">
          <label className="dialog__field-label">名称 *</label>
          <div className="ds-input ds-input--block">
            <input
              type="text"
              value={form.name}
              onChange={(e) => {
                set("name", e.target.value);
                if (saveError) setSaveError("");
              }}
              placeholder="例如：生产服务器"
            />
          </div>
          {saveError && <div className="dialog__field-error">{saveError}</div>}
        </div>

        <div className="dialog__field-row">
          <div className="dialog__field">
            <label className="dialog__field-label">主机 / IP *</label>
            <div className="ds-input ds-input--block">
              <input
                type="text"
                value={form.host}
                onChange={(e) => set("host", e.target.value)}
                placeholder="例如：192.168.1.10"
              />
            </div>
          </div>
          <div className="dialog__field" style={{ flex: "0 0 100px" }}>
            <label className="dialog__field-label">端口</label>
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
          <label className="dialog__field-label">用户名 *</label>
          <div className="ds-input ds-input--block">
            <span className="ds-input__icon">
              <Icon name="key" size={13} />
            </span>
            <input
              type="text"
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
              placeholder="例如：root"
            />
          </div>
        </div>

        <div className="dialog__field">
          <label className="dialog__field-label">认证方式</label>
          <select
            className="ds-select ds-select--block"
            value={form.authType}
            onChange={(e) => set("authType", e.target.value as AuthType)}
          >
            <option value="password">密码</option>
            <option value="key">私钥</option>
          </select>
        </div>

        {form.authType === "password" ? (
          <div className="dialog__field">
            <label className="dialog__field-label">密码</label>
            <div className="ds-input ds-input--block">
              <input
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder="输入密码"
              />
              <button
                className="ds-input__action"
                type="button"
                title={showPassword ? "隐藏密码" : "显示密码"}
                onClick={() => setShowPassword((v) => !v)}
              >
                <Icon name={showPassword ? "eye-off" : "eye"} size={13} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="dialog__field">
              <label className="dialog__field-label">私钥路径</label>
              <div className="ds-input ds-input--block">
                <input
                  type="text"
                  value={form.privateKeyPath}
                  onChange={(e) => set("privateKeyPath", e.target.value)}
                  placeholder="例如：~/.ssh/id_rsa"
                />
              </div>
            </div>
            <div className="dialog__field">
              <label className="dialog__field-label">私钥密码</label>
              <div className="ds-input ds-input--block">
                <input
                  type={showPassphrase ? "text" : "password"}
                  value={form.privateKeyPassphrase}
                  onChange={(e) => set("privateKeyPassphrase", e.target.value)}
                  placeholder="（可选）"
                />
                <button
                  className="ds-input__action"
                  type="button"
                  title={showPassphrase ? "隐藏密码" : "显示密码"}
                  onClick={() => setShowPassphrase((v) => !v)}
                >
                  <Icon name={showPassphrase ? "eye-off" : "eye"} size={13} />
                </button>
              </div>
            </div>
          </>
        )}

        <div className="dialog__field">
          <label className="dialog__field-label">分组</label>
          <select
            className="ds-select ds-select--block"
            value={form.groupId}
            onChange={(e) => set("groupId", e.target.value)}
          >
            <option value="">无分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>

        <div className="dialog__field">
          <div className="dialog__field-label dialog__field-label--row">
            <span>备注</span>
            <span className="dialog__field-optional">（可选）</span>
          </div>
          <div className="ds-input ds-input--block">
            <textarea
              value={form.memo}
              onChange={(e) => set("memo", e.target.value)}
              placeholder="填写备注说明"
              rows={2}
            />
          </div>
        </div>

        <div className="dialog__actions">
          <button
            className="ds-btn ds-btn--secondary"
            type="button"
            onClick={closeNewConnection}
          >
            取消
          </button>
          <button
            className="ds-btn ds-btn--brand"
            type="button"
            onClick={handleSave}
            disabled={!canSave}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
