# One family per deployment, NZD only, NZ English only

Fernledger is single-tenant. Each family deploys its own copy into its own Cloudflare account, and there is no shared, multi-family hosting. It handles NZD only, since Akahu covers NZ institutions only, and the interface is NZ English only. These boundaries keep the data model free of tenant IDs, currency conversion and translation layers. They also mean the project's authors never hold anyone's bank data.

## Consequences

- No `tenant_id` columns, no currency columns (amounts are NZD cents), no i18n framework.
- A currency Akahu reports for a linked Account's balance may be stored as a record of what Akahu said. It is never converted, summed or used in Fernledger's own amounts, which stay NZD cents.
- Supporting more than one family, or more than one currency, would be a new ADR and a significant migration, not a config switch.
