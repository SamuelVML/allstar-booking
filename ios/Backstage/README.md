# All Star Backstage — native iPhone test build

SwiftUI app, iOS 17+. Open `Backstage.xcodeproj` in Xcode. No third-party iOS packages and no Stripe/Cloudflare API keys are required in the app.

## Run on your iPhone

1. Deploy the backend from the same branch to **allstar-booking-test**, retaining its existing test D1 binding, Access AUD/team domain and Stripe sandbox secrets. The new `/api/admin/bookings` and `/api/admin/customers` endpoints must be deployed before native login can complete. Existing Access `/api/admin/*` protection covers both.
2. Open `ios/Backstage/Backstage.xcodeproj`.
3. Xcode > Settings > Accounts: sign in with your Apple Account.
4. Select the Backstage target > Signing & Capabilities > Team > your Personal Team. Keep automatic signing enabled. Change the bundle identifier to your own unique value if Xcode reports it is unavailable.
5. Connect and trust your iPhone; enable Developer Mode if Xcode requests it. Choose your iPhone as the run destination and press Run (Cmd+R).
6. Sign in through Cloudflare Access using an allowed staff email and the email code, then tap **Continue after signing in**.

A free Personal Team supports personal device testing; provisioning expires after seven days and requires rebuilding/reinstalling. TestFlight distribution requires Apple Developer Program membership. See https://developer.apple.com/help/account/basics/about-your-developer-account.

## Included

- Date-filtered bookings and appointment-date booked/paid totals.
- Complete, cancel and reschedule confirmed bookings using the existing revision-checked backend.
- Record full cash/card payments already received at the shop. This does not charge a card.
- Add walk-ins; block and remove time off.
- Customer search, loyalty balances and latest 100 bookings per customer.
- Staff authentication, sign out and a cover while the app is inactive.

The app is pinned to `https://allstar-booking-test.samuel-731.workers.dev`. No production selector is exposed. WebKit is used only for the existing Access login; the operational screens are native SwiftUI. A nonpersistent WebKit session holds Access cookies in memory. Only secure, unexpired CF_Authorization cookies matching the exact Worker host/path are sent to the API. HTTP redirects are rejected in the API client. The server still verifies JWT issuer, audience, expiry and staff allowlist. Existing same-origin JSON mutation checks remain enabled.

Sign-in is required after relaunch. Do not replace it with a shared service token embedded in the app. Use the configured one-time PIN method; third-party OAuth providers may disallow embedded webviews.

## Validation and remaining release work

Backend checks: `npx tsc --noEmit`, `node tests/native-api.mjs`, `npm run test:booking-management`, `npm run build`.

An Apple SDK/Xcode is unavailable in the build workspace, so Swift compilation, signing, on-device Access cookie transfer and UI operation are **not yet verified**. Run in Xcode and verify login, a date with test bookings, reschedule/cancel, time off, cash/card recording and customer lookup. Check expired-session sign-in and sign out. If a request fails with an uncertain result, refresh the booking list before retrying. Never mark Stripe bookings manually paid.

Totals are tied to appointment dates and include paid cancellations; they are not daily takings, profit or refund-adjusted revenue. No push notifications, product recommendations, product catalogue, refunds, App Store icon/screenshots or production release are included. Existing service prices are used; this work does not introduce the proposed €37.50 card / €35 cash pricing.
