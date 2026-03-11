/**
 * 账号分组管理弹窗
 * - 创建 / 重命名 / 删除分组
 * - 显示分组列表及账号数量
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FolderOpen, Plus, Pencil, Trash2, FolderPlus, AlertCircle } from 'lucide-react';
import {
  AccountGroup,
  getAccountGroups,
  createGroup,
  deleteGroup,
  renameGroup,
  addAccountsToGroup,
} from '../services/accountGroupService';
import './AccountGroupModal.css';

// ─── 分组管理弹窗 ──────────────────────────────────────────

interface AccountGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGroupsChanged: () => void;
}

export const AccountGroupModal = ({ isOpen, onClose, onGroupsChanged }: AccountGroupModalProps) => {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setGroups(getAccountGroups());
  }, []);

  useEffect(() => {
    if (isOpen) {
      reload();
      setNewName('');
      setRenamingId(null);
      setDeleteConfirmId(null);
      setError(null);
    }
  }, [isOpen, reload]);

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      // 重名检查
      if (groups.some((g) => g.name === name)) {
        setError(t('accounts.groups.error.duplicate', '分组名称已存在'));
        return;
      }
      createGroup(name);
      setNewName('');
      reload();
      onGroupsChanged();
    } catch (err) {
      console.error('Failed to create group:', err);
      setError(t('accounts.groups.error.createFailed', {
        error: String(err),
        defaultValue: '创建分组失败：{{error}}',
      }));
    }
  };

  const handleRename = (groupId: string) => {
    const name = renameValue.trim();
    if (!name) return;
    setError(null);
    try {
      // 重名检查（排除自己）
      if (groups.some((g) => g.id !== groupId && g.name === name)) {
        setError(t('accounts.groups.error.duplicate', '分组名称已存在'));
        return;
      }
      renameGroup(groupId, name);
      setRenamingId(null);
      reload();
      onGroupsChanged();
    } catch (err) {
      console.error('Failed to rename group:', err);
      setError(t('accounts.groups.error.renameFailed', {
        error: String(err),
        defaultValue: '重命名分组失败：{{error}}',
      }));
    }
  };

  const handleDelete = (groupId: string) => {
    setError(null);
    try {
      deleteGroup(groupId);
      setDeleteConfirmId(null);
      reload();
      onGroupsChanged();
    } catch (err) {
      console.error('Failed to delete group:', err);
      setError(t('accounts.groups.error.deleteFailed', {
        error: String(err),
        defaultValue: '删除分组失败：{{error}}',
      }));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal account-group-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <FolderOpen size={18} />
            {t('accounts.groups.manageTitle', '分组管理')}
          </h2>
          <button className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {/* 创建分组 */}
          <div className="group-create-row">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              placeholder={t('accounts.groups.newPlaceholder', '输入分组名称...')}
              maxLength={30}
            />
            <button
              className="btn btn-primary"
              onClick={handleCreate}
              disabled={!newName.trim()}
            >
              <Plus size={14} />
              {t('accounts.groups.create', '创建')}
            </button>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="group-modal-error">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}

          {/* 分组列表 */}
          {groups.length === 0 ? (
            <div className="group-modal-empty">
              <FolderPlus size={36} />
              <div>{t('accounts.groups.empty', '暂无分组，创建一个开始使用吧')}</div>
            </div>
          ) : (
            <div className="group-modal-list">
              {groups.map((group) => (
                <div key={group.id} className="group-modal-item">
                  <FolderOpen size={18} className="group-icon" />
                  <div className="group-info">
                    {renamingId === group.id ? (
                      <input
                        className="group-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename(group.id);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        onBlur={() => handleRename(group.id)}
                        autoFocus
                        maxLength={30}
                      />
                    ) : (
                      <>
                        <span className="group-name">{group.name}</span>
                        <span className="group-count">
                          {t('accounts.groups.accountCount', {
                            count: group.accountIds.length,
                            defaultValue: '{{count}} 个账号',
                          })}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="group-actions">
                    {deleteConfirmId === group.id ? (
                      <>
                        <button
                          className="group-action-btn danger"
                          onClick={() => handleDelete(group.id)}
                          title={t('common.confirm', '确认')}
                        >
                          ✓
                        </button>
                        <button
                          className="group-action-btn"
                          onClick={() => setDeleteConfirmId(null)}
                          title={t('common.cancel', '取消')}
                        >
                          ✗
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="group-action-btn"
                          onClick={() => {
                            setRenamingId(group.id);
                            setRenameValue(group.name);
                          }}
                          title={t('accounts.groups.rename', '重命名')}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="group-action-btn danger"
                          onClick={() => setDeleteConfirmId(group.id)}
                          title={t('common.delete', '删除')}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            {t('common.close', '关闭')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── 添加到分组弹窗 ──────────────────────────────────────────

interface AddToGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountIds: string[];
  onAdded: () => void;
}

export const AddToGroupModal = ({ isOpen, onClose, accountIds, onAdded }: AddToGroupModalProps) => {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setGroups(getAccountGroups());
      setNewName('');
      setError(null);
    }
  }, [isOpen]);

  const handleSelect = (groupId: string) => {
    setError(null);
    try {
      addAccountsToGroup(groupId, accountIds);
      onAdded();
      onClose();
    } catch (err) {
      console.error('Failed to add accounts to group:', err);
      setError(t('accounts.groups.error.addFailed', {
        error: String(err),
        defaultValue: '添加到分组失败：{{error}}',
      }));
    }
  };

  const handleCreateAndAdd = () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const group = createGroup(name);
      addAccountsToGroup(group.id, accountIds);
      onAdded();
      onClose();
    } catch (err) {
      console.error('Failed to create group and add accounts:', err);
      setError(t('accounts.groups.error.createAndAddFailed', {
        error: String(err),
        defaultValue: '新建分组并添加失败：{{error}}',
      }));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal add-to-group-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <FolderPlus size={18} />
            {t('accounts.groups.addToGroup', '移入分组')}
          </h2>
          <button className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="group-create-row">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateAndAdd(); }}
              placeholder={t('accounts.groups.createAndAdd', '新建分组并添加...')}
              maxLength={30}
            />
            <button
              className="btn btn-primary"
              onClick={handleCreateAndAdd}
              disabled={!newName.trim()}
            >
              <Plus size={14} />
            </button>
          </div>

          {groups.length > 0 && (
            <div className="add-to-group-list">
              {groups.map((group) => (
                <div
                  key={group.id}
                  className="add-to-group-item"
                  onClick={() => handleSelect(group.id)}
                >
                  <FolderOpen size={16} className="group-icon" />
                  <span className="group-name">{group.name}</span>
                  <span className="group-count">
                    {group.accountIds.length}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="group-modal-error">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AccountGroupModal;
