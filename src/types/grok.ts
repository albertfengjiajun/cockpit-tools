import type {
  CodebuddyUsage,
  OfficialQuotaResource,
  QuotaCategory,
  QuotaCategoryGroup,
} from "./codebuddy-suite";
import { normalizeTimestamp } from "../utils/dataExtract";

export interface GrokProductUsage {
  /** Original product value returned by xAI. */
  product: string;
  usagePercent?: number | null;
}

export interface GrokQuota {
  periodType?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  weeklyLimitPercent?: number | null;
  onDemandUsed?: number | null;
  onDemandCap?: number | null;
  prepaidBalance?: number | null;
  frequentUsage?: number | null;
  frequentLimit?: number | null;
  occasionalUsage?: number | null;
  occasionalLimit?: number | null;
  /** Original subscription tier returned by xAI; never localize this value. */
  subscriptionTier?: string | null;
  subscriptionStatus?: string | null;
  products: GrokProductUsage[];
}

/**
 * Sanitized account DTO returned to the UI. OAuth credentials remain in the
 * Rust backend; `access_token` is always empty for shared-view compatibility.
 */
export interface GrokAccount {
  id: string;
  email: string;
  access_token: "";
  tags?: string[] | null;
  first_name?: string | null;
  last_name?: string | null;
  user_id?: string | null;
  principal_id?: string | null;
  principal_type?: string | null;
  team_id?: string | null;
  profile_image_asset_id?: string | null;
  coding_data_retention_opt_out?: boolean | null;
  expires_at?: number | null;
  has_grok_code_access?: boolean | null;
  plan_type?: string;
  quota?: GrokQuota | null;
  status?: string | null;
  status_reason?: string | null;
  quota_query_last_error?: string | null;
  quota_query_last_error_at?: number | null;
  usage_updated_at?: number | null;
  created_at: number;
  last_used: number;
}

export interface GrokUsage extends CodebuddyUsage {
  totalUsedPercent: number | null;
  exhausted: boolean;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function timestampMs(value: unknown): number | null {
  const seconds = normalizeTimestamp(value);
  return seconds == null ? null : seconds * 1000;
}

function quotaClass(remainPercent: number | null): string {
  if (remainPercent == null) return "high";
  if (remainPercent <= 10) return "critical";
  if (remainPercent <= 30) return "low";
  if (remainPercent <= 60) return "medium";
  return "high";
}

function percentageResource(
  code: string,
  name: string,
  usedPercent: number,
  refreshAt: number | null,
): OfficialQuotaResource {
  const used = clampPercent(usedPercent);
  const remain = 100 - used;
  return {
    packageCode: code,
    packageName: name,
    cycleStartTime: null,
    cycleEndTime: null,
    deductionEndTime: null,
    expiredTime: null,
    total: 100,
    remain,
    used,
    usedPercent: used,
    remainPercent: remain,
    refreshAt,
    expireAt: null,
    isBasePackage: true,
  };
}

function amountResource(
  code: string,
  name: string,
  usedValue: number,
  totalValue: number,
  refreshAt: number | null,
): OfficialQuotaResource {
  const total = Math.max(0, totalValue);
  const used = Math.max(0, usedValue);
  const remain = Math.max(0, total - used);
  const usedPercent = total > 0 ? clampPercent((used / total) * 100) : 0;
  const remainPercent = total > 0 ? clampPercent((remain / total) * 100) : null;
  return {
    packageCode: code,
    packageName: name,
    cycleStartTime: null,
    cycleEndTime: null,
    deductionEndTime: null,
    expiredTime: null,
    total,
    remain,
    used,
    usedPercent,
    remainPercent,
    refreshAt,
    expireAt: null,
    isBasePackage: false,
  };
}

function balanceResource(
  name: string,
  balanceValue: number,
): OfficialQuotaResource {
  const balance = Math.max(0, balanceValue);
  return {
    packageCode: "grok-prepaid-balance",
    packageName: name,
    cycleStartTime: null,
    cycleEndTime: null,
    deductionEndTime: null,
    expiredTime: null,
    total: balance,
    remain: balance,
    used: 0,
    usedPercent: 0,
    remainPercent: balance > 0 ? 100 : null,
    refreshAt: null,
    expireAt: null,
    isBasePackage: false,
  };
}

function group(
  category: QuotaCategory,
  label: string,
  items: OfficialQuotaResource[],
): QuotaCategoryGroup {
  const total = items.reduce((sum, item) => sum + item.total, 0);
  const used = items.reduce((sum, item) => sum + item.used, 0);
  const remain = items.reduce((sum, item) => sum + item.remain, 0);
  const usedPercent = total > 0 ? clampPercent((used / total) * 100) : 0;
  const remainPercent = total > 0 ? clampPercent((remain / total) * 100) : null;
  return {
    key: category,
    label,
    used,
    total,
    remain,
    usedPercent,
    remainPercent,
    quotaClass: quotaClass(remainPercent),
    items,
    visible: items.length > 0,
  };
}

export function getGrokAccountDisplayEmail(account: GrokAccount): string {
  const email = account.email?.trim();
  if (email && email !== "unknown@grok.local") return email;
  const fullName = [account.first_name, account.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return (
    fullName ||
    account.principal_id?.trim() ||
    account.user_id?.trim() ||
    email ||
    account.id
  );
}

export function getGrokPlanRawValue(account: GrokAccount): string | null {
  return (
    account.plan_type?.trim() || account.quota?.subscriptionTier?.trim() || null
  );
}

/** Maps stable xAI tier identifiers to compact product names. */
export function getGrokPlanBadge(account: GrokAccount): string {
  const raw = getGrokPlanRawValue(account);
  // The official Grok CLI treats a missing subscription tier as the free tier.
  if (!raw) return "Free";
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  const compact = normalized.replace(/_/g, "");
  if (["SUBSCRIPTION_TIER_INVALID", "INVALID", "FREE"].includes(normalized)) {
    return "Free";
  }
  if (
    ["SUBSCRIPTION_TIER_GROK_PRO", "GROK_PRO"].includes(normalized) ||
    compact === "GROKPRO"
  ) {
    return "Grok Pro";
  }
  if (["SUBSCRIPTION_TIER_X_BASIC", "X_BASIC"].includes(normalized)) {
    return "X Basic";
  }
  if (["SUBSCRIPTION_TIER_X_PREMIUM", "X_PREMIUM"].includes(normalized)) {
    return "X Premium";
  }
  if (
    ["SUBSCRIPTION_TIER_X_PREMIUM_PLUS", "X_PREMIUM_PLUS"].includes(normalized)
  ) {
    return "X Premium+";
  }
  if (
    [
      "SUBSCRIPTION_TIER_SUPER_GROK_LITE",
      "SUBSCRIPTION_TIER_SUPERGROK_LITE",
    ].includes(normalized) ||
    compact === "SUPERGROKLITE"
  ) {
    return "SuperGrok Lite";
  }
  if (
    [
      "SUBSCRIPTION_TIER_SUPER_GROK_PRO",
      "SUBSCRIPTION_TIER_SUPERGROK_PRO",
    ].includes(normalized) ||
    compact === "SUPERGROKPRO"
  ) {
    return "SuperGrok Pro";
  }
  if (
    [
      "SUBSCRIPTION_TIER_SUPERGROK_HEAVY",
      "SUBSCRIPTION_TIER_GROK_HEAVY",
    ].includes(normalized) ||
    compact === "SUPERGROKHEAVY" ||
    compact === "GROKHEAVY"
  ) {
    return "SuperGrok Heavy";
  }
  if (normalized === "SUBSCRIPTION_TIER_SUPERGROK" || compact === "SUPERGROK") {
    return "SuperGrok";
  }
  return raw;
}

export function getGrokUsage(account: GrokAccount): GrokUsage {
  const weeklyPercent = finite(account.quota?.weeklyLimitPercent);
  const productPercents = (account.quota?.products ?? [])
    .map((product) => finite(product.usagePercent))
    .filter((value): value is number => value != null);
  const onDemandUsed = finite(account.quota?.onDemandUsed);
  const onDemandCap = finite(account.quota?.onDemandCap);
  const onDemandPercent =
    onDemandCap != null && onDemandCap > 0 && onDemandUsed != null
      ? (onDemandUsed / onDemandCap) * 100
      : null;
  const frequentUsage = finite(account.quota?.frequentUsage);
  const frequentLimit = finite(account.quota?.frequentLimit);
  const frequentPercent =
    frequentLimit != null && frequentLimit > 0 && frequentUsage != null
      ? (frequentUsage / frequentLimit) * 100
      : null;
  const occasionalUsage = finite(account.quota?.occasionalUsage);
  const occasionalLimit = finite(account.quota?.occasionalLimit);
  const occasionalPercent =
    occasionalLimit != null && occasionalLimit > 0 && occasionalUsage != null
      ? (occasionalUsage / occasionalLimit) * 100
      : null;
  const usagePercents = [
    weeklyPercent,
    ...productPercents,
    onDemandPercent,
    frequentPercent,
    occasionalPercent,
  ]
    .filter((value): value is number => value != null)
    .map(clampPercent);
  // The most constrained bucket drives account health and recommendations.
  const totalUsedPercent =
    usagePercents.length > 0 ? Math.max(...usagePercents) : null;
  const statusText = [
    account.status,
    account.status_reason,
    account.quota_query_last_error,
  ]
    .filter(Boolean)
    .join(" ");
  const exhausted =
    (totalUsedPercent != null && totalUsedPercent >= 100) ||
    /exhausted|used[\s_-]*up|insufficient|limit[\s_-]*(?:reached|exceeded)/i.test(
      statusText,
    );
  const isNormal =
    !account.quota_query_last_error &&
    !exhausted &&
    !/error|invalid|expired|disabled|unauthorized|forbidden|reauth/i.test(
      statusText,
    );
  const statusCode =
    account.quota_query_last_error ||
    account.status_reason ||
    account.status ||
    (account.quota ? "normal" : undefined);

  return {
    dosageNotifyCode: statusCode ?? undefined,
    dosageNotifyZh: statusCode ?? undefined,
    dosageNotifyEn: statusCode ?? undefined,
    isNormal,
    inlineSuggestionsUsedPercent: totalUsedPercent,
    chatMessagesUsedPercent: totalUsedPercent,
    allowanceResetAt: timestampMs(account.quota?.periodEnd),
    totalUsedPercent,
    exhausted,
  };
}

export function getGrokQuotaGroups(
  account: GrokAccount,
  t: (key: string, defaultValue?: string) => string,
): QuotaCategoryGroup[] {
  const quota = account.quota;
  const refreshAt = timestampMs(quota?.periodEnd);
  const baseItems: OfficialQuotaResource[] = [];
  const weeklyPercent = finite(quota?.weeklyLimitPercent);
  if (weeklyPercent != null) {
    baseItems.push(
      percentageResource(
        "grok-weekly-limit",
        t("grok.quota.weekly", "每周用量"),
        weeklyPercent,
        refreshAt,
      ),
    );
  }
  (quota?.products ?? []).forEach((product, index) => {
    const usagePercent = finite(product.usagePercent);
    if (usagePercent == null) return;
    baseItems.push(
      percentageResource(
        `grok-product-${index}`,
        product.product,
        usagePercent,
        refreshAt,
      ),
    );
  });
  const frequentLimit = finite(quota?.frequentLimit);
  if (frequentLimit != null && frequentLimit > 0) {
    baseItems.push(
      amountResource(
        "grok-frequent-tasks",
        t("grok.quota.frequent", "高频任务"),
        finite(quota?.frequentUsage) ?? 0,
        frequentLimit,
        refreshAt,
      ),
    );
  }
  const occasionalLimit = finite(quota?.occasionalLimit);
  if (occasionalLimit != null && occasionalLimit > 0) {
    baseItems.push(
      amountResource(
        "grok-occasional-tasks",
        t("grok.quota.occasional", "普通任务"),
        finite(quota?.occasionalUsage) ?? 0,
        occasionalLimit,
        refreshAt,
      ),
    );
  }

  const onDemandItems: OfficialQuotaResource[] = [];
  const onDemandUsed = finite(quota?.onDemandUsed);
  const onDemandCap = finite(quota?.onDemandCap);
  if (onDemandCap != null && onDemandCap > 0) {
    onDemandItems.push(
      amountResource(
        "grok-on-demand",
        t("grok.quota.onDemand", "按量用量"),
        onDemandUsed ?? 0,
        onDemandCap,
        refreshAt,
      ),
    );
  }

  const balanceItems: OfficialQuotaResource[] = [];
  const prepaidBalance = finite(quota?.prepaidBalance);
  if (prepaidBalance != null && prepaidBalance > 0) {
    balanceItems.push(
      balanceResource(t("grok.quota.balance", "余额与积分"), prepaidBalance),
    );
  }

  return [
    group("base", t("grok.quota.included", "套餐用量"), baseItems),
    group("activity", t("grok.quota.promotional", "活动额度"), []),
    group("extra", t("grok.quota.onDemand", "按量用量"), onDemandItems),
    group("other", t("grok.quota.balance", "余额与积分"), balanceItems),
  ];
}

export function hasGrokQuotaData(account: GrokAccount): boolean {
  const quota = account.quota;
  return Boolean(
    quota &&
    (finite(quota.weeklyLimitPercent) != null ||
      quota.products.some((product) => finite(product.usagePercent) != null) ||
      (finite(quota.frequentLimit) ?? 0) > 0 ||
      (finite(quota.occasionalLimit) ?? 0) > 0 ||
      (finite(quota.onDemandCap) ?? 0) > 0 ||
      (finite(quota.prepaidBalance) ?? 0) > 0),
  );
}
