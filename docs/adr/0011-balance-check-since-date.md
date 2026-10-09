# A Balance Check difference is dated "since" the last balance it agreed with

The spec for a Balance Check warning (issue #1) dates it from when the difference was first seen. Fernledger dates it from the earlier balance the span was checked against: "Balance differs from bank by $5.00 since 30 Sept" means the bank and the Transactions agreed on 30 September, so the missing or duplicated Transaction is dated after that. A first-seen date would only say when the Admin noticed, which can be weeks after the gap, and it would reset to a new date whenever an Import recomputed the same difference. The date of the last agreement narrows where to look, and it is stable because it is worked out from the balances, not from when each Import ran.

## Consequences

- The date is `checked_against` in `balance_checks`; no first-seen date is stored.
- A difference clears when a later Import fills the gap, and its "since" date moves with the balances; README [Correct](../../README.md#correct) has the rest of the rules.
