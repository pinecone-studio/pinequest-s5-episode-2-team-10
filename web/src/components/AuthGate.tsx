"use client";

import { useSyncExternalStore } from "react";
import { setFolderUser } from "@/lib/folderStore";
import { useAccount } from "@/lib/session";
import AuthScreen from "./AuthScreen";

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
  const signedIn = hydrated && account !== null;
  setFolderUser(account && hydrated ? account.id : null);
  return (
    <>
      {signedIn ? null : hydrated ? <AuthScreen /> : <div className="desk" />}
      {/* Keep the page in the tree so Next can prerender the segment. Hide it until sign-in. */}
      <div hidden={!signedIn} inert={!signedIn} key={account?.id ?? "signed-out"}>
        {children}
      </div>
    </>
  );
}
