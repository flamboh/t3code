import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export interface UsageLimitNotice {
  readonly occurrenceId: string;
  readonly provider: string;
  readonly windowType?: string;
  readonly resetsAt?: number;
  readonly message: string;
  readonly autoContinue?: boolean;
}

export function usageLimitAutoContinueEnabled(notice: UsageLimitNotice): boolean {
  return notice.autoContinue === true;
}

export function usageLimitAutoContinueLabel(notice: UsageLimitNotice): string {
  return usageLimitAutoContinueEnabled(notice) ? "Disable auto-continue" : "Enable auto-continue";
}

function providerLabel(provider: string): string {
  return provider === "claudeAgent" ? "Claude" : provider;
}

export function usageLimitBannerItem(notice: UsageLimitNotice): ComposerBannerStackItem {
  const reset =
    typeof notice.resetsAt === "number" && Number.isFinite(notice.resetsAt)
      ? formatUsageLimitReset(notice.resetsAt)
      : null;
  return {
    id: `usage-limit:${notice.occurrenceId}`,
    variant: "warning",
    icon: "!",
    title: `${providerLabel(notice.provider)} usage limit reached`,
    description: reset ? `${notice.message} Resets ${reset}.` : notice.message,
  };
}

export function formatUsageLimitReset(timestamp: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(timestamp),
  );
}

export function readUsageLimit(value: unknown): UsageLimitNotice | null {
  if (!value || typeof value !== "object") return null;
  const notice = value as Partial<UsageLimitNotice>;
  if (
    typeof notice.occurrenceId !== "string" ||
    typeof notice.provider !== "string" ||
    typeof notice.message !== "string"
  ) {
    return null;
  }
  return {
    occurrenceId: notice.occurrenceId,
    provider: notice.provider,
    message: notice.message,
    ...(notice.windowType === undefined ? {} : { windowType: notice.windowType }),
    ...(typeof notice.resetsAt === "number" && Number.isFinite(notice.resetsAt)
      ? { resetsAt: notice.resetsAt }
      : {}),
    ...(typeof notice.autoContinue === "boolean" ? { autoContinue: notice.autoContinue } : {}),
  };
}
