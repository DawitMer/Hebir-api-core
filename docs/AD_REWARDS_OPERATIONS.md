# Sponsored rewards operations

Run `npm run migration:run` with the direct production database URL before deploying the API. The migration idempotently inserts five Hebir house campaigns in `active` state; they have a 3,000 ETB budget each. Review creative and budgets in `POST/PATCH /operations/ad-rewards/campaigns`; only active, date-valid campaigns with budget remaining are delivered.

All monetary API values ending in `Minor` are Ethiopian birr minor units (100 = 1 ETB). Campaign reward is fixed server-side at 300 minor units. Set a campaign to `paused` or `ended` to stop future delivery; completion history remains immutable.

Driver cashout requests begin in `requested`. Operations must move them to `processing` and then `paid` only after the approved payout provider/manual settlement has a payment reference. `rejected` and `failed` requests are excluded from pending reservations, automatically restoring available balance. Do not mark a request paid merely because it was requested.

The current API applies the advertising settlement inside ride completion. Its receipt payload contains `fare` (gross), `riderCashDue`, `advertisingDiscount`, and `driverHebirCredit`; consumers must display `riderCashDue` as cash due.
