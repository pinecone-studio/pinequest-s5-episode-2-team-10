"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import PresentView from "@/components/PresentView";
import { useLang } from "@/lib/i18nClient";

function PresentInner() {
  const { tr } = useLang();
  const params = useSearchParams();
  const folderId = params.get("folder")?.trim() ?? "";
  if (!folderId) {
    return (
      <div className="present-root">
        <p className="present-empty">{tr("presentNoFolder")}</p>
      </div>
    );
  }
  return <PresentView folderId={folderId} />;
}

export default function PresentPage() {
  return (
    <Suspense
      fallback={
        <div className="present-root">
          <p className="present-empty">…</p>
        </div>
      }
    >
      <PresentInner />
    </Suspense>
  );
}
