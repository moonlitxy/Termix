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
  const closeNewConnection = useApp((s) => s.closeNewConnection);
  const loadSessions = useApp((s) => s.loadSessions);

  const [form, setForm] = useState<SessionInput>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name: editing.name,
        host: editing.host,
        port: editing.port,
        username: editing.username,
        authType: editing.authType,
        password: editing.password ?? "",
        privateKeyPath: editing.privateKeyPath ?? "",
        privateKeyPassphrase: editing.privateKeyPassphrase ?? "",
        groupId: editing.groupId ?? "",
        memo: editing.memo ?? "",
        encoding: editing.encoding,
      });
    } else {
      setForm(EMPTY);
    }
  }, [open, editing]);

  if (!open) return null;

  const set = <K extends keyof SessionInput>(key: K, val: SessionInput[K]) => {
    setForm((f) => ({ ...f, [key]: val }));
  };

  const canSave =
    form.name.trim() && form.host.trim() && form.username.trim() && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const input: SessionInput = {
        ...form,
        port: Number(form.port) || 22,
        groupId: form.groupId || undefined,
        memo: form.memo || undefined,
        password: form.authType === "password" ? form.password : undefined,
        privateKeyPath: form.authType === "key" ? form.privateKeyPath : undefined,
        privateKeyPassphrase:
          form.authType === "key" ? form.privateKeyPassphrase : undefined,
      };
      if (editing) {
        await ipc.sessionUpdate(editing.id, input);
      } else {
        await ipc.sessionCreate(input);
      }
      await loadSessions();
      closeNewConnection();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("save session failed:", e);
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
              onChange={(e) => set("name", e.target.value)}
              placeholder="例如：生产服务器"
            />
          </div>
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
            className="dialog__select"
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
                type="password"
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder="输入密码"
              />
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
                  type="password"
                  value={form.privateKeyPassphrase}
                  onChange={(e) => set("privateKeyPassphrase", e.target.value)}
                  placeholder="可选"
                />
              </div>
            </div>
          </>
        )}

        <div className="dialog__field">
          <label className="dialog__field-label">备注</label>
          <div className="ds-input ds-input--block">
            <textarea
              value={form.memo}
              onChange={(e) => set("memo", e.target.value)}
              placeholder="可选"
              rows={2}
            />
          </div>
        </div>

        <div className="dialog__field">
          <label className="dialog__field-label">分组</label>
          <select
            className="dialog__select"
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
