# Privacy and the law (NZ)

> **This is our understanding, not legal advice.** It was researched in October 2026 from the sources linked below. Law and terms change. If you rely on Fernledger for anything with legal consequences, such as acting under a Power of Attorney, check with a lawyer. The questions to ask are listed at the end.

Fernledger's maintainers collect no one's data. Each deployment is run by whoever deploys it, so **the obligations below fall on you, the deployer**, and not on the project.

## What a deployment holds

- **Transactions** for the tracked Accounts: date (time only where the bank supplies one, which is rare), amount, description, merchant, category, type, **the counterparty's account number**, card suffix, and payment particulars, code and reference. These often include other people's names.
- **Account balances.**
- **Email addresses:** Members' in Cloudflare Access, and the Admin's in every Change Log entry and in the record of each time the Rules are applied to all Transactions.
- **Notes** the Admin writes.

The counterparty account number and payment references are kept on purpose. An attorney may need to show exactly where money went.

## Privacy Act 2020

- **Your own household's finances:** very likely outside most of the Act. Section 27 says the collection and holding principles (IPPs 1–3A, 4(b) and 5–12) don't apply to an individual handling information "solely for the purposes of, or in connection with, the individual's personal or domestic affairs". The exception is anything "highly offensive to a reasonable person" (s 27(3)).
- **An attorney managing a parent's finances and sharing them with siblings:** *uncertain.* We found no Privacy Commissioner guidance or case law on this. One view is that the attorney holds the information as the parent's representative (s 11), which keeps it domestic. Get advice if it matters to you.
- **Storing data with Cloudflare overseas** isn't a "disclosure" under IPP 12 while Cloudflare only stores and processes it for you (s 11; [OPC guidance on third-party providers](https://www.privacy.org.nz/resources-and-learning/a-z-topics/working-with-third-party-providers/)). You remain fully responsible for it. Cloudflare acts as a processor under its [customer DPA](https://www.cloudflare.com/cloudflare-customer-dpa/).
- **Breach notification (Part 6):** agencies must notify the Privacy Commissioner "as soon as practicable" (s 114) and tell the people affected (s 115). The OPC treats 72 hours as a guide. Information held "solely for … personal or domestic affairs" is excluded (s 112), so households are normally outside Part 6.
- **Access and correction:** only the person, or their representative, can request their information (s 40). The OPC treats someone holding an EPA as acting on the person's behalf ([OPC](https://www.privacy.org.nz/resources-and-learning/knowledge-base/view/83/)). Family members have no rights just because they're family.

## Power of Attorney (PPPR Act 1988)

- **Best interests:** once the donor lacks capacity, their best interests are the attorney's "paramount consideration" (s 97A).
- **Consultation:** the attorney must consult the donor, anyone named in the EPA, and other attorneys (s 99A). The attorney must give information to anyone the EPA names for that purpose (s 99B).
- **Records:** the attorney must **keep records of every transaction** while the donor lacks capacity (s 99C). No retention period is stated. The court can order accounts and records to be produced (s 102).
- The Act neither expressly allows nor forbids sharing the donor's financial information with family. That's for the attorney to judge, guided by the EPA's wording and the donor's best interests.

## Akahu's developer terms

These are a contract, so they apply **even if the Privacy Act doesn't** ([Akahu Developer Terms](https://www.akahu.nz/developer-terms)):

- Comply with the Privacy Act "or provide a comparable level of protection" (cl 4.1.2).
- Keep appropriate security and use industry-standard cryptography (cl 4.1.3–4.1.4).
- Collect only what's needed for your purpose (cl 8.1.14).
- Tell Akahu about a breach "as soon as reasonably practicable" (cl 4.8).
- Delete data when the user asks (cl 7.9).
- **Open question: is ongoing use of a personal app allowed?** Clause 20 groups personal apps with the "Sandbox". Use is "solely permitted for the purpose of testing whether our Services are suitable" for your product, "in a non-production environment" (cl 20.2.3). You "must not provide access … to any User that is not part of your organisation" without Akahu's prior written consent (cl 20.2.4). "User" covers anyone using a product that uses Akahu data, which includes family members viewing the dashboard. Akahu may also end personal-app access at any time (cl 20.2.5). The terms (last updated 20 March 2025) have no "personal use" exception. We have asked Akahu for written confirmation, and this page will be updated with their answer. Until then, Fernledger treats Akahu as optional: everything works with CSV imports alone.

## How long to keep data

Fernledger never deletes data automatically. It keeps everything until you run the teardown. Attorneys must keep transaction records (PPPR s 99C) with no end date, and tax records may also need keeping. Decide your own retention period, ideally with advice.

## How Fernledger helps you meet these obligations

| Obligation | What Fernledger does |
|---|---|
| Security and encryption | Access sign-in, encrypted storage, read-only Members, Change Log ([Security](../README.md#security-and-privacy)) |
| Transparency to Members | An in-app **About your data** page saying what's held, who sees it, where it's stored, how long it's kept and who to ask |
| Access and correction requests | Full CSV export, and Overrides and Notes for corrections |
| Deletion on request | Documented teardown that exports, deletes everything, and, if you use Akahu Sync, revokes the Akahu token |
| Breach response | A checklist in [security.md](security.md) |
| Attorney record-keeping | Every Transaction kept with the counterparty account and references, Notes, the Change Log, and printable Reports |

## Questions to ask a lawyer

1. Does the Privacy Act's domestic-affairs exclusion cover me as attorney sharing my parent's finances with my siblings?
2. Who does my EPA say I must consult or inform, and does that cover the siblings who'll have access?
3. How long should I keep the s 99C transaction records, and for how long after the EPA ends?
4. If Akahu confirms personal-app use is fine, is there anything else in their terms I should act on?
