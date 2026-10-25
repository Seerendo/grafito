import { useEffect, useState } from "react";
import { setActor } from "@/app/actor";

export type AccountProfile = {
  userId: string;
  displayName: string;
  contactEmail: string;
  loginName: string;
  isAdmin: boolean;
  canAdmin?: boolean;
};

const fallback: AccountProfile = {
  userId: "",
  displayName: "Administrador",
  contactEmail: "",
  loginName: "",
  isAdmin: false,
  canAdmin: false,
};

let current = fallback;
const listeners = new Set<() => void>();

export function accountProfile(): AccountProfile {
  return current;
}

export function setAccountProfile(next: AccountProfile): void {
  current = next;
  setActor(next.displayName);
  listeners.forEach((listener) => listener());
}

export function clearAccountProfile(): void {
  current = fallback;
  setActor(fallback.displayName);
  listeners.forEach((listener) => listener());
}

export function subscribeAccount(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAccountProfile(): AccountProfile {
  const [profile, setProfile] = useState(current);
  useEffect(() => subscribeAccount(() => setProfile(accountProfile())), []);
  return profile;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : "";
  return (first + last).toLocaleUpperCase("es");
}
