# A per-Account Cutover Date separates Import from Sync; no cross-source matching

Each Account has a Cutover Date. Transactions before it come only from Imports, and transactions on or after it come only from Sync. Imported CSV rows have no Akahu ID, so matching across the two sources would rely on date, amount and description. That fails on repeated identical payments, such as two $50 transfers on the same day. A hard date boundary is predictable and can be checked by eye. Some banks give Akahu only about 12 months of history, so each Cutover Date must fall within the window Akahu returned.
