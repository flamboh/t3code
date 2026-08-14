export interface UsageLimitNotice {
  readonly occurrenceId: string;
  readonly provider: string;
  readonly resetsAt?: number;
  readonly message: string;
  readonly autoContinue?: boolean;
}

export interface UsageLimitPresentation {
  readonly title: string;
  readonly detail: string;
  readonly autoContinueEnabled: boolean;
  readonly autoContinueLabel: string;
}

export function usageLimitAutoContinueEnabled(notice: UsageLimitNotice): boolean {
  return notice.autoContinue === true;
}

function providerLabel(provider: string): string {
  return provider === "claudeAgent" ? "Claude" : provider;
}

export function usageLimitPresentation(notice: UsageLimitNotice): UsageLimitPresentation {
  const reset =
    typeof notice.resetsAt === "number" && Number.isFinite(notice.resetsAt)
      ? formatUsageLimitReset(notice.resetsAt)
      : null;
  return {
    title: `${providerLabel(notice.provider)} usage limit reached`,
    detail: reset ? `${notice.message} Resets ${reset}.` : notice.message,
    autoContinueEnabled: usageLimitAutoContinueEnabled(notice),
    autoContinueLabel: usageLimitAutoContinueEnabled(notice)
      ? "Disable auto-continue"
      : "Enable auto-continue",
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
    ...(typeof notice.resetsAt === "number" && Number.isFinite(notice.resetsAt)
      ? { resetsAt: notice.resetsAt }
      : {}),
    ...(typeof notice.autoContinue === "boolean" ? { autoContinue: notice.autoContinue } : {}),
  };
}
