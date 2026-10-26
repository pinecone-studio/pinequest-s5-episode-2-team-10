"use client";

import { Suspense, useState, useSyncExternalStore } from "react";
import { setFolderUser } from "@/lib/folderStore";
import { useAccount } from "@/lib/session";
import AppShell from "./AppShell";
import AuthScreen from "./AuthScreen";
import Landing from "./Landing";

type AuthMode = "login" | "register" | null;

/** Back from the Google redirect: go straight to sign-in so the code can be exchanged. */
function initialAuthMode(): AuthMode {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.has("code") || params.has("error") ? "login" : null;
}

function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/** Shows sign-in until this browser has an account. Folders stay tied to that account. */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const account = useAccount();
  const hydrated = useHydrated();
  const [authMode, setAuthMode] = useState<AuthMode>(initialAuthMode);
  const signedIn = hydrated && account !== null;
  setFolderUser(account && hydrated ? account.id : null);
  const signedOut = authMode ? (
    <AuthScreen key={authMode} initialMode={authMode} onBack={() => setAuthMode(null)} />
  ) : (
    <Landing onStart={setAuthMode} />
  );
  return (
    <>
      {signedIn ? null : hydrated ? signedOut : <div className="desk" />}
      {/* Keep the page in the tree so Next can prerender the segment. Hide it until sign-in. */}
      <div hidden={!signedIn} inert={!signedIn} key={account?.id ?? "signed-out"}>
        <Suspense fallback={<div className="app-shell" />}>
          <AppShell>{children}</AppShell>
        </Suspense>
      </div>
    </>
  );
}
