"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAccount } from "@/lib/session";

const AVATAR_UPDATED_EVENT = "saylo:profile-avatar-updated";

export function notifyProfileAvatarUpdated() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AVATAR_UPDATED_EVENT));
}

export default function AccountAvatar({ fallback, className }: { fallback: string; className: string }) {
  const account = useAccount();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
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
    setImageUrl(null);
    api.profileAvatar()
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(() => {
        if (active) setImageUrl(null);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [account?.id, revision]);

  return (
    <span className={className} aria-hidden="true">
      {imageUrl ? <Image src={imageUrl} alt="" fill unoptimized sizes="64px" style={{ objectFit: "cover" }} /> : fallback}
    </span>
  );
}
