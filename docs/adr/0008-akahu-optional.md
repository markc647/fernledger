# Akahu is optional; CSV Import is a first-class source

Fernledger works fully on CSV Imports alone, and Akahu Sync is an optional extra per Account. Akahu's developer terms (cl 20) only permit personal apps "for the purpose of testing … in a non-production environment", and require written consent for Users outside your organisation. Akahu can also end personal-app access at any time. Building the product around Sync would put every deployment at the mercy of one supplier's terms.

## Consequences

- Every feature (Categories, Rules, Transfers, Balance Check, Reports) must work for an Account with no Akahu link. The Balance Check uses the ledger balance from each CSV header when there's no Akahu balance.
- The Cutover Date exists only for Accounts linked to Akahu. Unlinked Accounts can receive repeated, overlapping Imports, so Import must recognise rows it already holds, using the bank's own unique ID where the export provides one.
- If Akahu confirms that ongoing personal use is fine, nothing changes. Sync stays optional.
