import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
import { applyVariables, buildVarDefs, type VarDef } from "../lib/variables";
import type { Snippet, SnippetInput } from "../types";

const EMPTY: SnippetInput = { title: "", command: "", groupId: undefined };

export function SnippetsView() {
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
      window.alert("请填写标题与命令");
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
    } catch (e) {
      window.alert(String(e));
    }
  };

  const send = async (command: string) => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab?.connectionId || !tab.shellId) {
      window.alert("请先打开一个已连接的终端标签页");
      return;
    }
    try {
      await ipc.terminalWrite(tab.connectionId, tab.shellId, command + "\n");
    } catch (e) {
      window.alert(String(e));
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
        <span className="fw-toolbar__title">命令片段</span>
        <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" title="新建命令片段" onClick={openNew}>
          <Icon name="plus" size={12} />新建片段
        </button>
      </div>
      <div className="sn-list">
        {snippets.length === 0 && <div className="fw-empty">暂无命令片段</div>}
        {snippets.map((s) => (
          <div className="ds-card sn-item" key={s.id}>
            <div className="sn-item__head">
              <span className="sn-item__title">{s.title}</span>
              <div className="sn-item__actions">
                <button
                  className="ds-btn ds-btn--secondary ds-btn--sm"
                  type="button"
                  title="插入到当前终端"
                  onClick={() => void insert(s)}
                >
                  <Icon name="send" size={12} />插入
                </button>
                <button
                  className="ds-btn ds-btn--tertiary ds-btn--icon"
                  type="button"
                  title="编辑"
                  onClick={() => openEdit(s)}
                >
                  <Icon name="edit" size={13} />
                </button>
                <button
                  className="ds-btn ds-btn--danger-subtle ds-btn--icon"
                  type="button"
                  title="删除"
                  onClick={() => {
                    if (window.confirm(`删除片段 ${s.title}？`)) {
                      void ipc.snippetDelete(s.id).then(load);
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
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{editingId ? "编辑片段" : "新建片段"}</span>
              <button
                className="ds-btn ds-btn--tertiary ds-btn--icon"
                type="button"
                title="关闭"
                onClick={() => setModalOpen(false)}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="form-row">
              <label>标题</label>
              <input
                className="ds-input"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="如 查看大文件"
              />
            </div>
            <div className="form-row">
              <label>命令</label>
              <textarea
                className="ds-input sn-form-cmd"
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
                placeholder="如 ls -lh /var/log | tail -n 20"
                rows={4}
              />
            </div>
            <div className="form-row">
              <label>分组</label>
              <select
                className="ds-select"
                value={form.groupId ?? ""}
                onChange={(e) => setForm({ ...form, groupId: e.target.value || undefined })}
              >
                <option value="">无分组</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button className="ds-btn ds-btn--secondary" type="button" title="取消：放弃本次修改" onClick={() => setModalOpen(false)}>
                取消
              </button>
              <button className="ds-btn ds-btn--brand" type="button" title="保存命令片段" onClick={() => void save()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
      {varModal && (
        <div className="modal-overlay" onClick={() => setVarModal(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>填写变量：{varModal.snippet.title}</span>
              <button
                className="ds-btn ds-btn--tertiary ds-btn--icon"
                type="button"
                title="关闭"
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
                  placeholder={`默认: ${v.defaultValue || "（空）"}`}
                />
              </div>
            ))}
            <div className="modal-actions">
              <button className="ds-btn ds-btn--secondary" type="button" title="取消：放弃插入" onClick={() => setVarModal(null)}>
                取消
              </button>
              <button className="ds-btn ds-btn--brand" type="button" title="插入：替换变量后发送到终端" onClick={() => void applyVars()}>
                插入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
