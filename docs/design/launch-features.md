# Launch implementation checklist

Scope baseline: 3 October 2026. **20 features: 14 full-depth, 6 thin.** This document records intended implementation, not completed work. All rows are initially unchecked. Architecture: [system design and diagrams](system-design.md); data: [core entities](core-entities.md).

Confirmed: MSBD first; tenant-isolated architecture; free basic access; self-service subscriptions plus negotiated assisted fees; agency-owned bKash accounts. Bengali-first UI and a responsive web experience apply throughout.

| Done | ID  | Feature                      | Depth | Owner module                | Launch completion criterion                                                                                                                  |
| ---- | --- | ---------------------------- | ----- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ]  | 1.1 | Homepage                     | Full  | Tenancy and Content         | MSBD branding, Bengali-first copy and working registration/pricing links on mobile and desktop                                               |
| [ ]  | 1.2 | Phone OTP registration       | Full  | Identity and Accounts       | Real SMS OTP, expiry/replay/abuse controls, tenant-bound account, consent and draft profile; family representation supported                 |
| [ ]  | 1.3 | Pricing page                 | Full  | Billing and Entitlements    | Three configured plans with actual prices/benefits and working purchase entry points                                                         |
| [ ]  | 1.4 | Success stories              | Thin  | Tenancy and Content         | Six approved config entries displayed; no CMS                                                                                                |
| [ ]  | 1.5 | About/contact                | Full  | Tenancy and Content         | Correct agency details, three branch addresses and usable maps/links                                                                         |
| [ ]  | 2.1 | My Profile and edit requests | Full  | Profiles, Media and Reviews | View own biodata/preferences/photos; save draft; submit edits/photos; pending/review results visible; published content protected            |
| [ ]  | 2.2 | My Matches                   | Full  | Discovery and Matching      | Same-agency approved suggestions and published agent recommendations, compatibility labels/explanations, no internal-note leakage            |
| [ ]  | 2.3 | Interest and mutual match    | Full  | Discovery and Matching      | Send/accept/decline; reciprocal requests converge on one pair; accepted pair notifies both members; contact consent remains explicit         |
| [ ]  | 2.4 | Inbox                        | Thin  | Notifications               | Paginated own-event list with Bengali templates; no chat or read/unread states                                                               |
| [ ]  | 2.5 | Payment status               | Full  | Billing and Entitlements    | Actual receipts, pending verification, outstanding assisted balance and subscription dates/access displayed correctly                        |
| [ ]  | 3.1 | Basic search                 | Full  | Discovery and Matching      | Age, religion, education, profession, current location, marital status and member-code lookup; scoped pagination and safe previews           |
| [ ]  | 3.2 | Advanced search              | Thin  | Discovery and Matching      | Same form with five extra plan-gated filters; backend rejects unauthorized filters                                                           |
| [ ]  | 3.3 | Profile detail/paywall       | Full  | Discovery and Matching      | Preview/detail/contact projections; quota-aware explicit access; no private fields before permission; clear upgrade action                   |
| [ ]  | 4.1 | Admin dashboard              | Thin  | Reporting                   | Registration, pending, active and confirmed-revenue count cards; sandbox revenue clearly distinguished                                       |
| [ ]  | 4.2 | Profile approval queue       | Full  | Profiles, Media and Reviews | Initial/edit/photo review, authorized reviewer, approve/reject notes, conflict handling and atomic publication                               |
| [ ]  | 4.3 | Agent client management      | Full  | Profiles, Media and Reviews | Authorized staff provisioned; clients created/assigned; assigned list/filter/edit/status actions; recommendations published through Matching |
| [ ]  | 4.4 | Plan management              | Thin  | Billing and Entitlements    | Agency admin edits three seeded plans; existing purchases retain their original terms                                                        |
| [ ]  | 5.1 | bKash sandbox checkout       | Full  | Billing and Entitlements    | Agency merchant checkout completes; server confirms provider result; retry/ambiguity recovery; one paid activation                           |
| [ ]  | 5.2 | Manual payment recording     | Full  | Billing and Entitlements    | Authorized agent/admin records cash/bank receipts against orders; partial balance correct; duplicate submissions do not double-credit        |
| [ ]  | 5.3 | Feature gating               | Thin  | Billing and Entitlements    | Three entitlement controls enforced server-side, including concurrent quota requests and subscription expiry                                 |

Proposed defaults carried from entity design: one profile per member account; modes `self_service`/`assisted`; one free and two paid plans; quota controls are full-profile views, contact views and advanced-search access. The five premium filters are height, income, complexion, family status and district of origin. Paid quotas reset per purchased term; free quotas monthly; repeat targets do not consume twice. Final values/wording need product confirmation.

## End-to-end acceptance journey

On the MSBD Bengali site, the CEO registers with a real phone OTP, completes biodata and submits it. The admin/assigned agent approves it, manages the client and publishes a recommendation. The member browses/searches, sees compatibility labels, expresses interest, and a second controlled test member accepts. Notifications appear. A gated operation offers a paid plan; the CEO completes bKash sandbox checkout, sees its receipt/access period and can perform the newly entitled action. Separately, an agent records partial/final manual receipts against an assisted-service order. Admin count cards reflect the correct environment and confirmed collections.

## Required cross-cutting acceptance

- A second synthetic tenant proves isolation across API reads/writes, sessions, relationships, cache keys and private media.
- Unapproved content, internal notes and protected contacts never appear in unauthorized API responses.
- Duplicate payments, stale approvals and concurrent final-quota requests preserve data correctness.
- Provider/worker failures show truthful pending/error states and recover without duplicate charges or activations.
- Bengali copy, dates, amounts, validation/error messages and mobile layouts work throughout; UTF-8 free-form text is preserved.
- Operational logging/alerts and a tested backup restore accompany live launch; exact service/recovery targets are agreed before production.

## Hard exclusions

CMS/page builder, PDF biodata, NID/Porichoy, chat, WhatsApp, SMS campaigns, tasks/follow-ups, meeting scheduling, analytics beyond count cards, Bengali search normalization, mobile apps, tenant-facing UI, agency SaaS billing, auto-renewal and prorated upgrades. Infrastructure monitoring, OTP delivery and payment reconciliation support launch correctness; they do not expand customer-facing scope.

The backend infrastructure scaffold is now implemented; these 20 product features remain unchecked. See [scaffold plan](backend-scaffold-plan.md) and [backend setup](../../README.md). No production migration or live payment has been performed.
