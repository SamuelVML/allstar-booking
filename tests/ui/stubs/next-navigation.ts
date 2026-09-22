/**
 * Stands in for `next/navigation`.
 *
 * `refresh()` is what Backstage calls after a mutation instead of reloading the
 * page, so the harness counts the calls rather than discarding them — the test
 * asserts one refresh per mutation.
 */

declare global {
  interface Window {
    /** Incremented by every `router.refresh()`. */
    __refreshes?: number;
  }
}

export function usePathname() {
  return "/admin/bookings";
}

export function useRouter() {
  return {
    push() {},
    replace() {},
    prefetch() {},
    back() {},
    forward() {},
    refresh() {
      window.__refreshes = (window.__refreshes ?? 0) + 1;
    },
  };
}

export function notFound(): never {
  throw new Error("notFound() was called outside Next.js");
}
