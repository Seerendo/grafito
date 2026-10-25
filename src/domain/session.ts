export const SESSION_PRESETS = [
  { seconds: 900, label: "15 min" },
  { seconds: 3600, label: "1 h" },
  { seconds: 28800, label: "8 h" },
  { seconds: 86400, label: "1 día" },
  { seconds: 604800, label: "7 días" },
] as const;

export const DEFAULT_SESSION_TTL = 28800;

export function allowedSessionTtl(seconds: number): boolean {
  return SESSION_PRESETS.some((item) => item.seconds === seconds);
}
