"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useBilling } from "@/lib/billingClient";
import { useLang } from "@/lib/i18nClient";
import { SUBSCRIPTION_REQUIRED_EVENT } from "@/lib/routeAccess";
import Modal from "./Modal";

const WARN_DAYS = 3;

/** A strip above the page when the trial or plan ends within a few days, or has ended. */
export function BillingBanner() {
  const { tr } = useLang();
  const { status } = useBilling();
  const pathname = usePathname();
  if (!status || !status.enforced || pathname === "/billing") return null;

  let text: string | null = null;
  if (status.state === "expired") text = tr("bannerExpired");
  else if (status.state === "trial" && status.days_left <= WARN_DAYS) text = tr("bannerTrial", { n: status.days_left });
  else if (status.state === "active" && status.days_left <= WARN_DAYS) text = tr("bannerPlanEnding", { n: status.days_left });
  if (!text) return null;

  return (
    <div className={status.state === "expired" ? "billing-banner is-expired" : "billing-banner"} role="status">
      <span>{text}</span>
      <Link href="/billing" className="billing-banner-link">
        {tr("billingRenew")}
      </Link>
    </div>
  );
}

/** Opens when the server refuses new work because the trial or plan is over. */
export function RenewDialog() {
  const { tr } = useLang();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(SUBSCRIPTION_REQUIRED_EVENT, show);
    return () => window.removeEventListener(SUBSCRIPTION_REQUIRED_EVENT, show);
  }, []);

  if (!open || pathname === "/billing") return null;
  const close = () => setOpen(false);
  return (
    <Modal title={tr("renewTitle")} onClose={close}>
      <p className="renew-text">{tr("billingExpiredNote")}</p>
      <div className="app-modal-actions">
        <button type="button" className="profile-secondary-button" onClick={close}>
          {tr("renewLater")}
        </button>
        <Link href="/billing" className="profile-primary-button" onClick={close}>
          {tr("billingRenew")}
        </Link>
      </div>
    </Modal>
  );
}
