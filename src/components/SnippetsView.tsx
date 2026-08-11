import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../store/app";
import { ipc } from "../lib/ipc";
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

  const insert = async (s: Snippet) => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab?.connectionId || !tab.shellId) {
      window.alert("请先打开一个已连接的终端标签页");
      return;
    }
    try {
      await ipc.terminalWrite(tab.connectionId, tab.shellId, s.command + "\n");
    } catch (e) {
      window.alert(String(e));
    }
  };

  return (
    <div className="sn-view">
      <div className="fw-toolbar">
        <span className="fw-toolbar__title">命令片段</span>
        <button className="ds-btn ds-btn--brand ds-btn--sm" type="button" onClick={openNew}>
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
                className="ds-input"
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
              <button className="ds-btn ds-btn--secondary" type="button" onClick={() => setModalOpen(false)}>
                取消
              </button>
              <button className="ds-btn ds-btn--brand" type="button" onClick={() => void save()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
