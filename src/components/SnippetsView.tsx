import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import { applyVariables, buildVarDefs, type VarDef } from "../lib/variables";
import { confirmDialog, toast } from "../store/feedback";
import { useFocusTrap } from "../lib/focusTrap";
import { useT } from "../lib/i18n";
import { scheduleRemoteCwdSync } from "../lib/shellCommand";
import { terminalRegistry } from "../lib/terminalRegistry";
import { selectWorkspaceTargetTab } from "../lib/workspaceTarget";
import type { Snippet, SnippetInput } from "../types";

const EMPTY: SnippetInput = { title: "", command: "", groupId: undefined };

export function SnippetsView() {
  const tr = useT();
  const groups = useApp((s) => s.groups);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SnippetInput>(EMPTY);
  // 变量填充弹窗
  const [varModal, setVarModal] = useState<{ snippet: Snippet; vars: VarDef[] } | null>(null);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, modalOpen || !!varModal);

  const load = async () => {
    try {
      setSnippets(await ipc.snippetList());
    } catch {
      setSnippets([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const openNew = () => {
    setEditingId(null);
    setForm(EMPTY);
    setModalOpen(true);
  };

  const openEdit = (s: Snippet) => {
    setEditingId(s.id);
    setForm({
      title: s.title,
      command: s.command,
      variables: s.variables,
      groupId: s.groupId,
    });
    setModalOpen(true);
  };

  const save = async () => {
    if (!form.title || !form.command) {
      toast.warning(tr("snip.needTitleCmd"));
      return;
    }
    try {
      if (editingId) {
        await ipc.snippetUpdate(editingId, form);
      } else {
        await ipc.snippetCreate(form);
      }
      setModalOpen(false);
      void load();
      toast.success(editingId ? tr("snip.updated") : tr("snip.created"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const send = async (command: string) => {
    const tab =
      selectWorkspaceTargetTab(tabs, activeTabId, terminalRegistry.getFocus()) ??
      tabs.find((t) => t.id === activeTabId);
    if (!tab?.connectionId || !tab.shellId) {
      toast.warning(tr("sftp.noConnectedTab"));
      return;
    }
    try {
      await ipc.terminalWrite(tab.connectionId, tab.shellId, command + "\n");
      scheduleRemoteCwdSync(command, tab.connectionId, tab.shellId);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const insert = async (s: Snippet) => {
    // 扫描命令中的 {{var}} 占位符，存在则弹窗让用户填写变量
    const vars = buildVarDefs(s.command, s.variables);
    if (vars.length > 0) {
      setVarValues(Object.fromEntries(vars.map((v) => [v.name, v.defaultValue])));
      setVarModal({ snippet: s, vars });
      return;
    }
    await send(s.command);
  };

  const applyVars = async () => {
    if (!varModal) return;
    const cmd = applyVariables(varModal.snippet.command, varValues);
    setVarModal(null);
    await send(cmd);
  };

  return (
    <div className="sn-view">
      <div className="fw-toolbar">
        <span className="fw-toolbar__title">{tr("snip.title")}</span>
        <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" title={tr("snip.newTitle")} onClick={openNew}>
          <Icon name="plus" size={12} />{tr("snip.new")}</button>
      </div>
      <div className="sn-list">
        {snippets.length === 0 && (
          <div className="fw-empty">
            <span className="fw-empty__icon">
              <Icon name="scroll-text" size={28} />
            </span>
            <div className="fw-empty__title">{tr("snip.empty")}</div>
            <div className="fw-empty__sub">{tr("snip.emptySub")}</div>
          </div>
        )}
        {snippets.map((s) => (
          <div className="ds-card sn-item" key={s.id}>
            <div className="sn-item__head">
              <span className="sn-item__title">{s.title}</span>
              <div className="sn-item__actions">
                <button
                  className="ds-btn ds-btn--secondary ds-btn--sm"
                  type="button"
                  title={tr("snip.runHint")}
                  onClick={() => void insert(s)}
                >
                  <Icon name="send" size={12} />{tr("snip.send")}</button>
                <button
                  className="ds-btn ds-btn--tertiary ds-btn--icon"
                  type="button"
                  title={tr("snip.edit")}
                  onClick={() => openEdit(s)}
                >
                  <Icon name="edit" size={13} />
                </button>
                <button
                  className="ds-btn ds-btn--danger-subtle ds-btn--icon"
                  type="button"
                  title={tr("snip.delete")}
                  onClick={async () => {
                    const confirmed = await confirmDialog({
                      title: tr("snip.deleteHint"),
                      message: tr("snip.deleteMsg", { n: s.title }),
                      confirmText: tr("common.delete"),
                      danger: true,
                    });
                    if (!confirmed) return;
                    try {
                      await ipc.snippetDelete(s.id);
                      await load();
                      toast.success(tr("snip.deleted"));
                    } catch (e) {
                      toast.error(String(e));
                    }
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
            <div className="sn-item__cmd">{s.command}</div>
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
            aria-label={editingId ? tr("snip.editTitle") : tr("snip.newTitle")}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <span>{editingId ? tr("snip.editTitle") : tr("snip.newTitle")}</span>
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
              <label>{tr("snip.titleLabel")}</label>
              <input
                className="ds-input"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder={tr("snip.titlePh")}
              />
            </div>
            <div className="form-row">
              <label>{tr("snip.command")}</label>
              <textarea
                className="ds-input sn-form-cmd"
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
                placeholder={tr("snip.commandPh")}
                rows={4}
              />
            </div>
            <div className="form-row">
              <label>{tr("snip.group")}</label>
              <select
                className="ds-select"
                value={form.groupId ?? ""}
                onChange={(e) => setForm({ ...form, groupId: e.target.value || undefined })}
              >
                <option value="">{tr("conn.noGroup")}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button className="ds-btn ds-btn--secondary" type="button" title={tr("fwd.cancelEdit")} onClick={() => setModalOpen(false)}>{tr("common.cancel")}</button>
              <button className="ds-btn ds-btn--brand" type="button" title={tr("snip.save")} onClick={() => void save()}>{tr("snip.save")}</button>
            </div>
          </div>
        </div>
      )}
      {varModal && (
        <div className="modal-overlay" onClick={() => setVarModal(null)}>
          <div
            className="modal-card"
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label={`填写变量：${varModal.snippet.title}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <span>填写变量：{varModal.snippet.title}</span>
              <button
                className="ds-btn ds-btn--tertiary ds-btn--icon"
                type="button"
                title={tr("common.close")}
                onClick={() => setVarModal(null)}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="sn-var-preview">{varModal.snippet.command}</div>
            {varModal.vars.map((v) => (
              <div className="form-row" key={v.name}>
                <label>{v.name}</label>
                <input
                  className="ds-input"
                  value={varValues[v.name] ?? ""}
                  onChange={(e) =>
                    setVarValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                  }
                  placeholder={v.defaultValue ? tr("sftp.varDefault", { d: v.defaultValue }) : tr("sftp.varDefaultEmpty")}
                />
              </div>
            ))}
            <div className="modal-actions">
              <button className="ds-btn ds-btn--secondary" type="button" title={tr("snip.cancelInsert")} onClick={() => setVarModal(null)}>{tr("common.cancel")}</button>
              <button className="ds-btn ds-btn--brand" type="button" title={tr("snip.execVars")} onClick={() => void applyVars()}>{tr("snip.send")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
