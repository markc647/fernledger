# Data stored in Oceania by default; region chosen at setup

The setup script creates the D1 database and R2 bucket with a location hint of `${REGION:-oc}`. For NZ users that is Oceania. Cloudflare doesn't publish which city, and has no NZ storage region. Other deployers can set `REGION`. D1 read replication stays off, so data is not copied to other regions. Smart Placement is on, so the Worker runs next to its database rather than at the visitor's nearest edge location.

## Consequences

- A location hint is not a residency guarantee. Cloudflare offers contractual jurisdictions only for the EU and FedRAMP, and there is none for NZ or AU. The docs must say this plainly.
- Requests are still received at the nearest edge location, for example Auckland. Only storage and, with Smart Placement, processing sit in Oceania.
- Location is fixed when a resource is created. Moving it means an export and re-import, so we rely on the setup script rather than Wrangler's auto-provisioning, which may not take a location.
