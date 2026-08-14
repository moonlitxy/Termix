import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import type { ForwardRule, ForwardRuleInput } from "../types";

const TYPE_LABEL: Record<string, string> = {
  local: "本地",
  remote: "远程",
  dynamic: "动态",
};

export function ForwardView() {
  const sessions = useApp((s) => s.sessions);
  const [rules, setRules] = useState<ForwardRule[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
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
      window.alert("请填写名称与本地端口");
      return;
    }
    if (form.type !== "dynamic" && !form.remotePort) {
      window.alert(form.type === "remote" ? "远程转发需要填写服务端监听端口" : "本地转发需要填写远程端口");
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
    } catch (e) {
      window.alert(String(e));
    }
  };

  const sessionName = (id?: string) =>
    id ? sessions.find((s) => s.id === id)?.name ?? "未知会话" : "未绑定";

  return (
    <div className="fw-view">
      <div className="fw-toolbar">
        <span className="fw-toolbar__title">端口转发</span>
        <button
          className="ds-btn ds-btn--brand ds-btn--sm"
          type="button"
          onClick={openNew}
        >
          <Icon name="plus" size={12} />新建规则
        </button>
      </div>
      <div className="fw-list">
        {rules.length === 0 && <div className="fw-empty">暂无转发规则</div>}
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
                onClick={() => {
                  console.log(`[forward] ${r.enabled ? "stop" : "start"} rule`, r.id, r.name);
                  void (r.enabled ? ipc.forwardStop(r.id) : ipc.forwardStart(r.id))
                    .then(load)
                    .catch((e) => console.error("[forward] toggle rule failed:", e));
                }}
              >
                <Icon name={r.enabled ? "pause" : "play"} size={12} />
                {r.enabled ? "停用" : "启用"}
              </button>
              <button
                className="ds-btn ds-btn--secondary ds-btn--sm"
                type="button"
                onClick={() => openEdit(r)}
              >
                <Icon name="edit" size={12} />
                编辑
              </button>
              <button
                className="ds-btn ds-btn--danger-subtle ds-btn--sm"
                type="button"
                onClick={() => {
                  if (window.confirm(`删除规则 ${r.name}？`)) {
                    void ipc.forwardDelete(r.id).then(load);
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
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{editingId ? "编辑转发规则" : "新建转发规则"}</span>
              <button
                className="ds-btn ds-btn--tertiary ds-btn--icon"
                type="button"
                onClick={() => setModalOpen(false)}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="form-row">
              <label>类型</label>
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
              <label>规则名称</label>
              <input
                className="ds-input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如 MySQL 本地转发"
              />
            </div>
            <div className="form-row">
              <label>本地地址</label>
              <input
                className="ds-input"
                value={form.localHost ?? "127.0.0.1"}
                onChange={(e) => setForm({ ...form, localHost: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label>本地端口</label>
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
                  <label>{form.type === "remote" ? "服务端监听地址" : "远程地址"}</label>
                  <input
                    className="ds-input"
                    value={form.remoteHost ?? ""}
                    onChange={(e) => setForm({ ...form, remoteHost: e.target.value })}
                    placeholder={form.type === "remote" ? "留空默认 0.0.0.0" : "如 127.0.0.1"}
                  />
                </div>
                <div className="form-row">
                  <label>{form.type === "remote" ? "服务端监听端口" : "远程端口"}</label>
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
              <label>绑定会话</label>
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
              <button className="ds-btn ds-btn--secondary" type="button" onClick={() => setModalOpen(false)}>
                取消
              </button>
              <button
                className="ds-btn ds-btn--brand"
                type="button"
                onClick={() => void save()}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
