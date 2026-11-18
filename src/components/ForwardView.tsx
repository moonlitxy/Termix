import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import { confirmDialog, toast } from "../store/feedback";
import { useFocusTrap } from "../lib/focusTrap";
import { useT } from "../lib/i18n";
import type { ForwardRule, ForwardRuleInput } from "../types";

export function ForwardView() {
  const tr = useT();
  const TYPE_LABEL: Record<string, string> = {
    local: tr("fwd.type.local"),
    remote: tr("fwd.type.remote"),
    dynamic: tr("fwd.type.dynamic"),
  };
  const sessions = useApp((s) => s.sessions);
  const [rules, setRules] = useState<ForwardRule[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, modalOpen);
  const [form, setForm] = useState<ForwardRuleInput>({
    type: "local",
    name: "",
    localHost: "127.0.0.1",
    localPort: 3306,
    remoteHost: "127.0.0.1",
    remotePort: 3306,
    sessionId: undefined,
  });

  const load = async () => {
    try {
      setRules(await ipc.forwardList());
    } catch {
      setRules([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const openNew = () => {
    setEditingId(null);
    setForm({
      type: "local",
      name: "",
      localHost: "127.0.0.1",
      localPort: 3306,
      remoteHost: "127.0.0.1",
      remotePort: 3306,
      sessionId: undefined,
    });
    setModalOpen(true);
  };

  const openEdit = (r: ForwardRule) => {
    setEditingId(r.id);
    setForm({
      type: r.type,
      name: r.name,
      localHost: r.localHost,
      localPort: r.localPort,
      remoteHost: r.remoteHost,
      remotePort: r.remotePort,
      sessionId: r.sessionId,
    });
    setModalOpen(true);
  };

  const save = async () => {
    if (!form.name || !form.localPort) {
      toast.warning(tr("fwd.needNamePort"));
      return;
    }
    if (form.type !== "dynamic" && !form.remotePort) {
      toast.warning(
        form.type === "remote"
          ? tr("fwd.needRemotePort")
          : tr("fwd.needLocalPort")
      );
      return;
    }
    try {
      if (editingId) {
        await ipc.forwardUpdate(editingId, form);
      } else {
        await ipc.forwardCreate(form);
      }
      setModalOpen(false);
      void load();
      toast.success(editingId ? tr("fwd.updated") : tr("fwd.created"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const sessionName = (id?: string) =>
    id ? sessions.find((s) => s.id === id)?.name ?? tr("fwd.unknownSession") : tr("fwd.unbound");

  return (
    <div className="fw-view">
      <div className="fw-toolbar">
        <span className="fw-toolbar__title">{tr("fwd.title")}</span>
        <button
          className="ds-btn ds-btn--brand ds-btn--sm"
          type="button"
          title={tr("fwd.newRuleTitle")}
          onClick={openNew}
        >
          <Icon name="plus" size={12} />新建规则
        </button>
      </div>
      <div className="fw-list">
        {rules.length === 0 && (
          <div className="fw-empty">
            <span className="fw-empty__icon">
              <Icon name="arrow-right-to-line" size={28} />
            </span>
            <div className="fw-empty__title">{tr("fwd.empty")}</div>
            <div className="fw-empty__sub">
              创建规则后，流量会通过已连接的 SSH 会话转发
            </div>
          </div>
        )}
        {rules.map((r) => (
          <div className="ds-card fw-row" key={r.id}>
            <div className="fw-row__main">
              <span className="fw-row__name">{r.name}</span>
              <span className="ds-tag ds-tag--neutral">{TYPE_LABEL[r.type] ?? r.type}</span>
              <span className="fw-row__path">
                {r.type === "dynamic"
                  ? `${r.localHost}:${r.localPort} → SOCKS5`
                  : r.type === "remote"
                  ? `${r.remoteHost || "0.0.0.0"}:${r.remotePort} → ${r.localHost || "127.0.0.1"}:${r.localPort}`
                  : `${r.localHost}:${r.localPort} → ${r.remoteHost}:${r.remotePort}`}
              </span>
              <span className="fw-row__session">绑定：{sessionName(r.sessionId)}</span>
            </div>
            <div className="fw-row__actions">
              {r.enabled ? (
                <span className="ds-tag ds-tag--success">运行中</span>
              ) : (
                <span className="ds-tag ds-tag--neutral">已停用</span>
              )}
              <button
                className="ds-btn ds-btn--secondary ds-btn--sm"
                type="button"
                title={r.enabled ? tr("fwd.disableTitle") : tr("fwd.enableTitle")}
                onClick={() => {
                  console.log(`[forward] ${r.enabled ? "stop" : "start"} rule`, r.id, r.name);
                  void (r.enabled ? ipc.forwardStop(r.id) : ipc.forwardStart(r.id))
                    .then(load)
                    .catch((e) => {
                      console.error("[forward] toggle rule failed:", e);
                      toast.error(String(e));
                    });
                }}
              >
                <Icon name={r.enabled ? "pause" : "play"} size={12} />
                {r.enabled ? tr("fwd.disable") : tr("fwd.enable")}
              </button>
              <button
                className="ds-btn ds-btn--secondary ds-btn--sm"
                type="button"
                title={tr("fwd.editTitle")}
                onClick={() => openEdit(r)}
              >
                <Icon name="edit" size={12} />
                编辑
              </button>
              <button
                className="ds-btn ds-btn--danger-subtle ds-btn--sm"
                type="button"
                title={tr("fwd.deleteTitle")}
                onClick={async () => {
                  const confirmed = await confirmDialog({
                    title: tr("fwd.deleteRule"),
                    message: `确定删除规则「${r.name}」？`,
                    confirmText: tr("common.delete"),
                    danger: true,
                  });
                  if (!confirmed) return;
                  try {
                    await ipc.forwardDelete(r.id);
                    await load();
                    toast.success(tr("fwd.deleted"));
                  } catch (e) {
                    toast.error(String(e));
                  }
                }}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {modalOpen && (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div
            className="modal-card"
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label={editingId ? tr("fwd.editRule") : tr("fwd.newRule")}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <span>{editingId ? tr("fwd.editRule") : tr("fwd.newRule")}</span>
              <button
                className="ds-btn ds-btn--tertiary ds-btn--icon"
                type="button"
                title={tr("common.close")}
                onClick={() => setModalOpen(false)}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="form-row">
              <label>{tr("fwd.type")}</label>
              <select
                className="ds-select"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as ForwardRuleInput["type"] })}
              >
                <option value="local">本地端口转发</option>
                <option value="dynamic">动态 SOCKS 代理</option>
                <option value="remote">远程端口转发</option>
              </select>
            </div>
            <div className="form-row">
              <label>{tr("fwd.name")}</label>
              <input
                className="ds-input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={tr("fwd.namePh")}
              />
            </div>
            <div className="form-row">
              <label>{tr("fwd.localAddr")}</label>
              <input
                className="ds-input"
                value={form.localHost ?? "127.0.0.1"}
                onChange={(e) => setForm({ ...form, localHost: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label>{tr("fwd.localPort")}</label>
              <input
                className="ds-input"
                type="number"
                value={form.localPort}
                onChange={(e) => setForm({ ...form, localPort: Number(e.target.value) })}
              />
            </div>
            {form.type === "remote" && (
              <div className="form-hint" style={{ marginBottom: 8 }}>
                远程转发：远程端口为服务端监听端口，收到的连接将转发到本地地址/端口
              </div>
            )}
            {form.type !== "dynamic" && (
              <>
                <div className="form-row">
                  <label>{form.type === "remote" ? tr("fwd.serverBindAddr") : tr("fwd.remoteAddr")}</label>
                  <input
                    className="ds-input"
                    value={form.remoteHost ?? ""}
                    onChange={(e) => setForm({ ...form, remoteHost: e.target.value })}
                    placeholder={form.type === "remote" ? tr("fwd.bindAddrPh") : tr("fwd.remoteAddrPh")}
                  />
                </div>
                <div className="form-row">
                  <label>{form.type === "remote" ? tr("fwd.serverBindPort") : tr("fwd.remotePort")}</label>
                  <input
                    className="ds-input"
                    type="number"
                    value={form.remotePort}
                    onChange={(e) => setForm({ ...form, remotePort: Number(e.target.value) })}
                  />
                </div>
              </>
            )}
            {form.type === "dynamic" && (
              <div className="form-hint" style={{ marginBottom: 8 }}>
                本机监听端口将作为 SOCKS5 代理，目标地址由连接时动态指定
              </div>
            )}
            <div className="form-row">
              <label>{tr("fwd.session")}</label>
              <select
                className="ds-select"
                value={form.sessionId ?? ""}
                onChange={(e) => setForm({ ...form, sessionId: e.target.value || undefined })}
              >
                <option value="">未绑定</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button className="ds-btn ds-btn--secondary" type="button" title={tr("fwd.cancelEdit")} onClick={() => setModalOpen(false)}>{tr("common.cancel")}</button>
              <button
                className="ds-btn ds-btn--brand"
                type="button"
                title={tr("fwd.save")}
                onClick={() => void save()}
              >{tr("fwd.save")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
