"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiRequestError, api } from "@/lib/api";
import { formatDay, formatMnt, setBillingStatus } from "@/lib/billingClient";
import type { MessageKey } from "@/lib/i18n";
import { useLang } from "@/lib/i18nClient";
import type { BillingPayment, BillingStatus } from "@/lib/types";
import Modal from "./Modal";

const POLL_MS = 3000;

type Phase = "loading" | "waiting" | "paid" | "expired" | "error";

function errorKey(error: unknown): MessageKey {
  const code = error instanceof ApiRequestError ? error.code : "";
  if (code === "payment_unavailable") return "payUnavailable";
  if (code === "payments_disabled") return "billingNotReady";
  if (code === "billing_not_needed") return "billingAdminNote";
  if (code === "network" || code === "timeout") return "serverOffline";
  return "payFailed";
}

const isExpired = (payment: BillingPayment) => !!payment.expires_at && Date.now() > Date.parse(payment.expires_at);

/**
 * Pays for one period with QPay: shows the invoice's QR code (and bank app links on phones), then
 * asks the server every few seconds until QPay reports the payment.
 */
export default function PayDialog({ onClose, onPaid }: { onClose: () => void; onPaid: (status: BillingStatus) => void }) {
  const { tr } = useLang();
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [payment, setPayment] = useState<BillingPayment | null>(null);
  const [error, setError] = useState<MessageKey>("payFailed");
  const [paidUntil, setPaidUntil] = useState<string | null>(null);
  const checking = useRef(false);

  useEffect(() => {
    let active = true;
    api
      .createInvoice()
      .then((created) => {
        if (!active) return;
        setPayment(created);
        setPhase(created.status === "paid" ? "paid" : isExpired(created) ? "expired" : "waiting");
      })
      .catch((cause) => {
        if (!active) return;
        setError(errorKey(cause));
        setPhase("error");
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (phase !== "waiting" || !payment) return;
    const timer = window.setInterval(() => {
      if (checking.current) return;
      if (isExpired(payment)) {
        setPhase("expired");
        return;
      }
      checking.current = true;
      api
        .billingPayment(payment.id)
        .then((check) => {
          if (check.payment.status !== "paid") return;
          setBillingStatus(check.billing);
          setPaidUntil(check.billing.paid_until);
          setPhase("paid");
          onPaid(check.billing);
        })
        .catch(() => {
          /* the next tick tries again */
        })
        .finally(() => {
          checking.current = false;
        });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [phase, payment, onPaid]);

  function newInvoice() {
    setPhase("loading");
    setPayment(null);
    setAttempt((n) => n + 1);
  }

  // Rendered on <body>: the page column's backdrop filter would otherwise pin the fixed dialog to it.
  return createPortal(
    <Modal title={tr("payTitle")} onClose={onClose}>
      <div className="pay-dialog" aria-live="polite">
        {phase === "loading" && (
          <div className="pay-state">
            <span className="pay-spinner" aria-hidden />
            <p>{tr("authWorking")}</p>
          </div>
        )}

        {phase === "error" && (
          <div className="pay-state">
            <p className="profile-field-error" role="alert">
              {tr(error)}
            </p>
            {error !== "billingNotReady" && error !== "billingAdminNote" && (
              <button type="button" className="profile-primary-button" onClick={newInvoice}>
                {tr("payNew")}
              </button>
            )}
          </div>
        )}

        {phase === "waiting" && payment && (
          <>
            <p className="pay-amount">
              <span>{tr("payAmount")}</span>
              <strong>{formatMnt(payment.amount_mnt)}</strong>
            </p>
            {payment.qr_image && (
              // A data URL from QPay; next/image adds nothing here.
              // eslint-disable-next-line @next/next/no-img-element
              <img className="pay-qr" src={`data:image/png;base64,${payment.qr_image}`} alt={tr("payQrAlt")} width={232} height={232} />
            )}
            <p className="pay-hint">{tr("payScan")}</p>
            {payment.bank_links.length > 0 && (
              <div className="pay-banks">
                <p>{tr("payBanks")}</p>
                <ul>
                  {payment.bank_links.map((bank) => (
                    <li key={bank.link}>
                      <a href={bank.link}>
                        {bank.logo && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={bank.logo} alt="" width={28} height={28} loading="lazy" />
                        )}
                        <span>{bank.name}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="pay-waiting">
              <span className="pay-dot" aria-hidden />
              {tr("payWaiting")}
            </p>
          </>
        )}

        {phase === "expired" && (
          <div className="pay-state">
            <p>{tr("payExpired")}</p>
            <button type="button" className="profile-primary-button" onClick={newInvoice}>
              {tr("payNew")}
            </button>
          </div>
        )}

        {phase === "paid" && (
          <div className="pay-state is-paid">
            <span className="pay-check" aria-hidden>
              <svg width="28" height="28" viewBox="0 0 28 28">
                <path d="m7 14.5 4.5 4.5L21 9.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <p role="status">{tr("payDone", { date: formatDay(paidUntil) })}</p>
            <button type="button" className="profile-primary-button" onClick={onClose}>
              {tr("close")}
            </button>
          </div>
        )}
      </div>
    </Modal>,
    document.body,
  );
}
