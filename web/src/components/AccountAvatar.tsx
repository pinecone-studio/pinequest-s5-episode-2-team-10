"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAccount } from "@/lib/session";

const AVATAR_UPDATED_EVENT = "saylo:profile-avatar-updated";

export function notifyProfileAvatarUpdated() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AVATAR_UPDATED_EVENT));
}

export default function AccountAvatar({ fallback, className, previewUrl }: { fallback: string; className: string; previewUrl?: string | null }) {
  const account = useAccount();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageAccountId, setImageAccountId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(AVATAR_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(AVATAR_UPDATED_EVENT, refresh);
  }, []);

  useEffect(() => {
    if (!account?.id) return;
    let active = true;
    let objectUrl: string | null = null;
    api.profileAvatar()
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
        setImageAccountId(account.id);
      })
      .catch(() => {
        if (active) {
          setImageUrl(null);
          setImageAccountId(account.id);
        }
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [account?.id, revision]);

  const displayedImageUrl = imageAccountId === account?.id ? imageUrl : null;
  return (
    <span className={className} aria-hidden="true">
      {previewUrl || displayedImageUrl ? <Image src={previewUrl || displayedImageUrl || ""} alt="" fill unoptimized sizes="64px" style={{ objectFit: "cover" }} /> : fallback}
    </span>
  );
}
