/**
 * 账号分组服务
 * 独立于标签系统，数据存储在 localStorage
 */

const STORAGE_KEY = 'agtools.account_groups';

let idCounter = 0;
function generateId(): string {
  return `grp_${Date.now()}_${++idCounter}`;
}

export interface AccountGroup {
  id: string;
  name: string;
  accountIds: string[];
  createdAt: number;
}

function loadGroups(): AccountGroup[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveGroups(groups: AccountGroup[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // ignore
  }
}

export function getAccountGroups(): AccountGroup[] {
  return loadGroups();
}

export function createGroup(name: string): AccountGroup {
  const groups = loadGroups();
  const group: AccountGroup = {
    id: generateId(),
    name: name.trim(),
    accountIds: [],
    createdAt: Date.now(),
  };
  groups.push(group);
  saveGroups(groups);
  return group;
}

export function deleteGroup(groupId: string): void {
  const groups = loadGroups().filter((g) => g.id !== groupId);
  saveGroups(groups);
}

export function renameGroup(groupId: string, name: string): AccountGroup | null {
  const groups = loadGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) return null;
  group.name = name.trim();
  saveGroups(groups);
  return group;
}

export function addAccountsToGroup(groupId: string, accountIds: string[]): AccountGroup | null {
  const groups = loadGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) return null;
  const existing = new Set(group.accountIds);
  for (const id of accountIds) {
    if (!existing.has(id)) {
      group.accountIds.push(id);
      existing.add(id);
    }
  }
  saveGroups(groups);
  return group;
}

export function removeAccountsFromGroup(groupId: string, accountIds: string[]): AccountGroup | null {
  const groups = loadGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) return null;
  const toRemove = new Set(accountIds);
  group.accountIds = group.accountIds.filter((id) => !toRemove.has(id));
  saveGroups(groups);
  return group;
}

/** 清理不存在的账号ID（当账号被删除时调用） */
export function cleanupDeletedAccounts(existingAccountIds: Set<string>): void {
  const groups = loadGroups();
  let changed = false;
  for (const group of groups) {
    const before = group.accountIds.length;
    group.accountIds = group.accountIds.filter((id) => existingAccountIds.has(id));
    if (group.accountIds.length !== before) changed = true;
  }
  if (changed) saveGroups(groups);
}
