"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

/** Whether Google sign-in is configured; without it the sign-in button is hidden. */
export const AUTH_ENABLED = Boolean(URL && KEY);

let client: SupabaseClient | null = null;

/** Whether the Google provider is turned on in the Supabase dashboard. Unknown (network error) counts as on. */
export async function googleEnabled(): Promise<boolean> {
  if (!AUTH_ENABLED) return false;
  try {
    const res = await fetch(`${URL}/auth/v1/settings`, { headers: { apikey: KEY! }, cache: "no-store" });
    if (!res.ok) return true;
    const settings = (await res.json()) as { external?: Record<string, boolean> };
    return settings.external?.google !== false;
  } catch {
    return true;
  }
}

/** Browser Supabase client for sign-in only. The session is kept in localStorage. */
export function supabase(): SupabaseClient | null {
  if (!AUTH_ENABLED || typeof window === "undefined") return null;
  client ??= createClient(URL!, KEY!, {
    auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
  });
  return client;
}
