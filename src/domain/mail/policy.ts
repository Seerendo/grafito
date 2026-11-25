/**
 * Limits of the email module: defaults, or the app_setting key mail_policy set by an operator.
 * Values out of range are clamped, so a hand-edited setting cannot unbound the worker. Relative
 * imports allow direct Node tests.
 */

export type MailProviderId = "imap" | "gmail" | "microsoft";

export const MAIL_PROVIDERS: MailProviderId[] = ["imap", "gmail", "microsoft"];

export type MailPolicy = {
  /** Providers people may connect. */
  providers: MailProviderId[];
  /** Email domains allowed for new accounts (empty: any). */
  domains: string[];
  maxAccountsPerUser: number;
  minIntervalSeconds: number;
  defaultIntervalSeconds: number;
  maxHistoryDays: number;
  /** Largest attachment that is downloaded at all. */
  maxAttachmentBytes: number;
  /** Attachments up to this size may be fetched while syncing when an account asks for it. */
  prefetchAttachmentBytes: number;
  /** Bytes of downloaded attachments per person (0: no limit besides the vault quota). */
  attachmentQuotaBytes: number;
  /** Jobs one worker runs at once. */
  concurrency: number;
  /** Jobs of one provider running at once across workers. */
  providerConcurrency: number;
  /** Message bodies longer than this are not stored (the message still lists). */
  maxBodyBytes: number;
  /** Days a message stays after its account is disconnected (0: deleted at once). */
  retentionDays: number;
  /** Index message bodies for search (subjects and addresses always are). */
  indexBodies: boolean;
  /** All syncing stops (operational control). */
  paused: boolean;
  /** Providers whose syncing is paused. */
  pausedProviders: MailProviderId[];
};

export const DEFAULT_MAIL_POLICY: MailPolicy = {
  providers: ["imap", "gmail", "microsoft"],
  domains: [],
  maxAccountsPerUser: 5,
  minIntervalSeconds: 120,
  defaultIntervalSeconds: 300,
  /** 0: no limit (the whole mailbox, like the mail server shows it). */
  maxHistoryDays: 0,
  maxAttachmentBytes: 25 * 1024 * 1024,
  prefetchAttachmentBytes: 1024 * 1024,
  attachmentQuotaBytes: 2 * 1024 * 1024 * 1024,
  concurrency: 4,
  providerConcurrency: 8,
  maxBodyBytes: 1024 * 1024,
  retentionDays: 0,
  indexBodies: true,
  paused: false,
  pausedProviders: [],
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 200),
    ),
  ];
}

function providers(value: unknown, fallback: MailProviderId[]): MailProviderId[] {
  if (!Array.isArray(value)) return fallback;
  return MAIL_PROVIDERS.filter((id) => value.includes(id));
}

/** A complete policy from whatever was stored. */
export function parseMailPolicy(raw: unknown): MailPolicy {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_MAIL_POLICY;
  const minInterval = clamp(value.minIntervalSeconds, 60, 86_400, d.minIntervalSeconds);
  return {
    providers: providers(value.providers, d.providers),
    domains: list(value.domains),
    maxAccountsPerUser: clamp(value.maxAccountsPerUser, 1, 50, d.maxAccountsPerUser),
    minIntervalSeconds: minInterval,
    defaultIntervalSeconds: clamp(
      value.defaultIntervalSeconds,
      minInterval,
      86_400,
      Math.max(minInterval, d.defaultIntervalSeconds),
    ),
    maxHistoryDays: clamp(value.maxHistoryDays, 0, 36500, d.maxHistoryDays),
    maxAttachmentBytes: clamp(value.maxAttachmentBytes, 1024, 1024 ** 3, d.maxAttachmentBytes),
    prefetchAttachmentBytes: clamp(
      value.prefetchAttachmentBytes,
      0,
      50 * 1024 * 1024,
      d.prefetchAttachmentBytes,
    ),
    attachmentQuotaBytes: clamp(value.attachmentQuotaBytes, 0, 1024 ** 4, d.attachmentQuotaBytes),
    concurrency: clamp(value.concurrency, 1, 64, d.concurrency),
    providerConcurrency: clamp(value.providerConcurrency, 1, 256, d.providerConcurrency),
    maxBodyBytes: clamp(value.maxBodyBytes, 16 * 1024, 16 * 1024 * 1024, d.maxBodyBytes),
    retentionDays: clamp(value.retentionDays, 0, 3650, d.retentionDays),
    indexBodies: value.indexBodies !== false,
    paused: value.paused === true,
    pausedProviders: providers(value.pausedProviders, []),
  };
}

/** The interval an account asks for, within the policy. */
export function syncInterval(policy: MailPolicy, asked: number | null | undefined): number {
  const value = Number(asked);
  if (!Number.isFinite(value) || value <= 0) return policy.defaultIntervalSeconds;
  return Math.min(86_400, Math.max(policy.minIntervalSeconds, Math.round(value)));
}

/** The history window an account asks for, within the policy. */
/**
 * Days of history an account copies; 0 means all of it. Without a choice, as much as the policy
 * allows (all, by default), so every folder holds what the mail server shows.
 */
export function historyDays(policy: MailPolicy, asked: number | null | undefined): number {
  const max = policy.maxHistoryDays;
  const value = Number(asked);
  if (!Number.isFinite(value) || value <= 0) return max;
  const days = Math.max(1, Math.round(value));
  return max > 0 ? Math.min(max, days) : days;
}

/** Whether a new history window reaches further back than the old one. */
export function widerHistory(before: number, after: number): boolean {
  if (before === 0) return false;
  return after === 0 || after > before;
}

/** Whether an email address's domain is allowed by the policy. */
export function domainAllowed(policy: MailPolicy, email: string): boolean {
  if (policy.domains.length === 0) return true;
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return policy.domains.some((item) => domain === item || domain.endsWith(`.${item}`));
}

/** Exponential backoff with full jitter, at least Retry-After when the provider sent one. */
export function backoffMs(
  attempt: number,
  random: number,
  retryAfterMs: number | null = null,
  baseMs = 30_000,
  capMs = 60 * 60 * 1000,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(baseMs / 2 + random * (ceiling - baseMs / 2));
  return Math.max(jittered, retryAfterMs ?? 0);
}
