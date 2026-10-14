# Approved owner decisions

## D06 — Bookly pricing authority

- Status: approved by the owner
- Date: 2026-10-14
- Scope: website, booking engine and Backstage catalogue. No production change
  is authorised by this decision.

Verbatim:

> OWNER DECISION — D06: BOOKLY PRICING AUTHORITY
>
> Bookly is the authoritative source for All Star service prices and durations.
>
> Reconcile the website, booking engine, and Backstage against the existing Bookly catalogue.
>
> Where website prices differ from Bookly, retain Bookly prices.
>
> Do not modify Bookly's existing prices.
>
> Do not merge distinct services solely because their durations match.
>
> Preserve historical appointment prices.
>
> Add automated tests ensuring consistent prices across the customer booking flow, checkout, and Backstage.
>
> Record this as an approved owner decision in the release documentation.
>
> No production changes authorized.

Implementation: `service-mapping-contract.md` (mapping, behaviour changes and
open items); catalogue source `bookly-catalogue-2026-10-14.json`; regression
`tests/catalogue-consistency.mjs`.
