"use client";

import { useSyncExternalStore } from "react";
import type { AccountProfile } from "./types";

const TOKEN_KEY = "pitchcoach:user-token";
const ACCOUNT_KEY = "pitchcoach:account";

export type Account = AccountProfile;

let account: Account | null | undefined;
const listeners = new Set<() => void>();

function readStored(): Account | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!token || !raw) return null;
    const parsed = JSON.parse(raw) as Partial<Account>;
    if (!parsed?.id || !parsed.email) return null;
    return {
      id: parsed.id,
      email: parsed.email,
      username: typeof parsed.username === "string" ? parsed.username : null,
      role: parsed.role === "admin" ? "admin" : "member",
    };
  } catch {
    return null;
  }
}

export function readAccount(): Account | null {
  if (account === undefined) account = readStored();
  return account;
}

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function publish(next: Account | null) {
  account = next;
  listeners.forEach((listener) => listener());
}

export function saveSession(session: Account & { access_token: string }) {
  const next = { id: session.id, email: session.email, username: session.username ?? null, role: session.role };
  try {
    localStorage.setItem(TOKEN_KEY, session.access_token);
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the session lasts until reload */
  }
  publish(next);
}

export function updateAccountUsername(username: string | null) {
  const current = readAccount();
  if (!current) return;
  const next = { ...current, username };
  try {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(next));
  } catch {
    /* private mode: keep the updated name until reload */
  }
  publish(next);
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    /* already blocked */
  }
  publish(null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAccount(): Account | null {
  return useSyncExternalStore(subscribe, readAccount, () => null);
}
