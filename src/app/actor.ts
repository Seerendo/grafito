const FALLBACK = "Administrador";

let current = FALLBACK;

export function actorName(): string {
  return current;
}

export function setActor(name: string): void {
  const next = name.trim();
  current = next || FALLBACK;
}
