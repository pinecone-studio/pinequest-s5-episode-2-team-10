"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { SUBSCRIPTION_REQUIRED_EVENT } from "./routeAccess";
import { useAccount } from "./session";
import type { BillingStatus } from "./types";

type Snapshot = { status: BillingStatus | null; failed: boolean };

const EMPTY: Snapshot = { status: null, failed: false };
const REFRESH_EVERY_MS = 30_000;

let snapshot: Snapshot = EMPTY;
let accountId: string | null = null;
let inflight: Promise<void> | null = null;
let fetchedAt = 0;
const listeners = new Set<() => void>();

function emit(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** Fetches the subscription state again (one request at a time). */
export function refreshBilling(): Promise<void> {
  if (inflight) return inflight;
  const forAccount = accountId;
  inflight = api
    .billingStatus()
    .then((status) => {
      if (forAccount === accountId) emit({ status, failed: false });
    })
    .catch(() => {
      if (forAccount === accountId) emit({ status: snapshot.status, failed: true });
    })
    .finally(() => {
      fetchedAt = Date.now();
      inflight = null;
    });
  return inflight;
}

/** Uses a state the server just returned (after a payment) without another request. */
export function setBillingStatus(status: BillingStatus) {
  fetchedAt = Date.now();
  emit({ status, failed: false });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The signed-in account's trial or paid period. `status` is null until the first answer. */
export function useBilling(): Snapshot {
  const account = useAccount();
  const id = account?.id ?? null;

  useEffect(() => {
    if (!id) return;
    if (accountId !== id) {
      accountId = id;
      emit(EMPTY);
      fetchedAt = 0;
    }
    if (Date.now() - fetchedAt > REFRESH_EVERY_MS) void refreshBilling();
  }, [id]);

  useEffect(() => {
    const refresh = () => {
      if (accountId && Date.now() - fetchedAt > REFRESH_EVERY_MS) void refreshBilling();
    };
    const blocked = () => {
      if (accountId) void refreshBilling();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener(SUBSCRIPTION_REQUIRED_EVENT, blocked);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(SUBSCRIPTION_REQUIRED_EVENT, blocked);
    };
  }, []);

  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

/** True when new work (pitches, recordings, analysis) is blocked. Unknown counts as allowed; the server decides. */
export function useBillingLocked(): boolean {
  const { status } = useBilling();
  return status ? !status.allowed : false;
}

export function formatMnt(amount: number): string {
  return `${amount.toLocaleString("en-US")}₮`;
}

export function formatDay(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}
