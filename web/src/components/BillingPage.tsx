"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { formatDay, formatMnt, refreshBilling, useBilling } from "@/lib/billingClient";
import type { MessageKey } from "@/lib/i18n";
import { useLang } from "@/lib/i18nClient";
import { useAccount } from "@/lib/session";
import type { BillingPayment, BillingState } from "@/lib/types";
import PayDialog from "./PayDialog";

const STATE_LABEL: Record<BillingState, MessageKey> = {
  admin: "billingStateAdmin",
  trial: "billingStateTrial",
  active: "billingStateActive",
  expired: "billingStateExpired",
};

const PAYMENT_LABEL: Record<BillingPayment["status"], MessageKey> = {
  paid: "billingStatusPaid",
  pending: "billingStatusPending",
  expired: "billingStatusClosed",
  cancelled: "billingStatusClosed",
};

/** The account's trial or plan, buying another period with QPay, and past payments. */
export default function BillingPage() {
  const { tr } = useLang();
  const account = useAccount();
  const { status, failed } = useBilling();
  const [payments, setPayments] = useState<BillingPayment[] | null>(null);
  const [reload, setReload] = useState(0);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    if (!account?.id) return;
    let active = true;
    api
      .billingPayments()
      .then((rows) => {
        if (active) setPayments(rows);
      })
      .catch(() => {
        if (active) setPayments([]);
      });
    return () => {
      active = false;
    };
  }, [account?.id, reload]);

  const onPaid = useCallback(() => setReload((n) => n + 1), []);

  return (
    <main className="profile-page billing-page">
      <Link href="/" className="profile-back">
        <ChevronLeft />
        {tr("profileBack")}
      </Link>

      <header className="profile-hero">
        <h1>{tr("billingTitle")}</h1>
      </header>

      {!status ? (
        failed ? (
          <div className="profile-card profile-state" role="alert">
            <p>{tr("billingLoadFailed")}</p>
            <button type="button" className="profile-secondary-button" onClick={() => void refreshBilling()}>
              {tr("retry")}
            </button>
          </div>
        ) : (
          <p className="profile-card profile-state" role="status">
            {tr("foldersLoading")}
          </p>
        )
      ) : (
        <>
          <section className="profile-card billing-status" aria-label={tr("billingTitle")}>
            <span className={`billing-pill is-${status.state}`}>{tr(STATE_LABEL[status.state])}</span>
            {status.state === "admin" ? (
              <p className="billing-status-detail">{tr("billingAdminNote")}</p>
            ) : status.state === "expired" ? (
              <>
                <p className="billing-status-main">{status.ends_at ? tr("billingEndedOn", { date: formatDay(status.ends_at) }) : tr("billingStateExpired")}</p>
                <p className="billing-status-detail">{tr("billingExpiredNote")}</p>
              </>
            ) : (
              <>
                <p className="billing-status-main">{tr("billingDaysLeft", { n: status.days_left })}</p>
                <p className="billing-status-detail">{tr("billingUntil", { date: formatDay(status.ends_at) })}</p>
              </>
            )}
          </section>

          {status.state !== "admin" && (
            <section className="profile-card billing-plan" aria-labelledby="billing-plan-title">
              <div className="profile-card-heading">
                <h2 id="billing-plan-title">{tr("billingPlanTitle")}</h2>
              </div>
              <div className="billing-plan-body">
                {status.payments_enabled && (
                  <p className="billing-price">
                    <strong>{formatMnt(status.price_mnt)}</strong>
                    <span>{tr("billingPerPeriod", { days: status.period_days })}</span>
                  </p>
                )}
                <ul className="billing-features">
                  {(["billingFeature1", "billingFeature2", "billingFeature3"] as const).map((key) => (
                    <li key={key}>
                      <CheckIcon />
                      {tr(key)}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="profile-primary-button billing-buy"
                  onClick={() => setPaying(true)}
                  disabled={!status.payments_enabled}
                >
                  {tr("billingRenew")}
                </button>
                <p className="billing-plan-note">{tr(status.payments_enabled ? "billingStackNote" : "billingNotReady")}</p>
              </div>
            </section>
          )}

          <section className="profile-card" aria-labelledby="billing-history-title">
            <div className="profile-card-heading">
              <h2 id="billing-history-title">{tr("billingHistory")}</h2>
            </div>
            {payments === null ? (
              <p className="profile-state" role="status">
                {tr("foldersLoading")}
              </p>
            ) : payments.length === 0 ? (
              <p className="profile-state">{tr("billingHistoryEmpty")}</p>
            ) : (
              <ul className="billing-history">
                {payments.map((payment) => (
                  <li key={payment.id}>
                    <span>{formatDay(payment.paid_at ?? payment.created_at)}</span>
                    <strong>{formatMnt(payment.amount_mnt)}</strong>
                    <span className={`billing-badge is-${payment.status}`}>{tr(PAYMENT_LABEL[payment.status])}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {paying && <PayDialog onClose={() => setPaying(false)} onPaid={onPaid} />}
    </main>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="m10 3-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
