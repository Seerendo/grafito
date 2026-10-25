export function Mark() {
  return (
    <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--color-inset)" />
      <path
        d="M16 6.5 24.5 11.5v9L16 25.5 7.5 20.5v-9Z"
        fill="var(--color-elevated)"
        stroke="var(--color-accent)"
        strokeWidth="1.4"
      />
      <path d="M16 6.5v19M7.5 11.5 16 17l8.5-5.5" fill="none" stroke="var(--color-accent)" strokeWidth="1.2" />
    </svg>
  );
}
