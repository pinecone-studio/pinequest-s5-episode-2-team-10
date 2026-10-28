import { langHeaders } from "./i18nClient";
import { readToken } from "./session";

/** Fired when the server says the free trial or paid period is over; the app shell opens the renew dialog. */
export const SUBSCRIPTION_REQUIRED_EVENT = "saylo:subscription-required";

export function notifySubscriptionRequired() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SUBSCRIPTION_REQUIRED_EVENT));
}

/** Headers for this app's own /api routes: the reply language and who is asking. */
export function routeHeaders(): Record<string, string> {
  const token = readToken();
  return { ...langHeaders(), ...(token ? { "X-Access-Token": token } : {}) };
}

/** Opens the renew dialog when a route answered 402. */
export function checkSubscription(res: Response | null | undefined) {
  if (res?.status === 402) notifySubscriptionRequired();
}
