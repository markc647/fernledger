# A Balance Check difference is dated "since" the previous bank balance

The spec for a Balance Check warning (issue #1) dates it from when the difference was first seen. Fernledger dates it from the previous bank balance the span was checked against: "Balance differs from bank by $5.00 since 30 Sept" means the Transactions since the bank's 30 September balance don't add up to the change in the bank's balance, so the missing or duplicated Transaction is dated after that. If the 30 September balance itself differed from the one before it, that earlier difference is reported on its own; each span is compared with the balance just before it. A first-seen date would only say when the Admin noticed, which can be weeks after the gap, and it would reset to a new date whenever an Import recomputed the same difference. The date of the previous balance narrows where to look, and it is stable because it is worked out from the balances, not from when each Import ran.

## Consequences

- The date is `checked_against` in `balance_checks`; no first-seen date is stored.
- A difference clears when a later Import fills the gap, and its "since" date moves with the balances; README [Correct](../../README.md#correct) has the rest of the rules.
