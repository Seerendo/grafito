/**
 * What an extension's switch and status line say, from the administrator's choice and the
 * connection check (server/extensions.ts).
 */

export type ExtensionCheckLike = { ok: boolean; service: boolean };

export type ExtensionPhase =
  /** Needs no service: on or off as chosen. */
  | "local"
  /** Its service answers. */
  | "connected"
  /** On, but its service does not answer: paused until it does. */
  | "paused"
  /** Off, and its service does not answer: it cannot be turned on. */
  | "offline";

export function extensionPhase(enabled: boolean, check: ExtensionCheckLike): ExtensionPhase {
  if (!check.service) return "local";
  if (check.ok) return "connected";
  return enabled ? "paused" : "offline";
}

/** The app uses it: chosen and its check passed. */
export function extensionActive(enabled: boolean, check: ExtensionCheckLike): boolean {
  return enabled && check.ok;
}

/** Turning on needs the check to pass; turning off always works. */
export function canSwitch(enabled: boolean, check: ExtensionCheckLike): boolean {
  return enabled || check.ok;
}
