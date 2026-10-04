# Reference schema validation

Validated on 3 October 2026 using local PostgreSQL 15 in a newly initialized, isolated temporary database. No existing application database was used. The server accepted only a temporary Unix socket, with TCP listening disabled.

`launch-core-schema.sql` applied successfully with `ON_ERROR_STOP=1`. All 17 tables, foreign keys, constraints, indexes, functions, triggers and tenant RLS policies were accepted.

`schema-checks.sql` passed 16 explicit negative/isolation checks:

1. Duplicate email inside one agency rejected.
2. Assignment to an account in another agency rejected.
3. Recommendation referencing a candidate in another agency rejected.
4. Inverted preferred age range rejected.
5. A second pending profile-content review rejected.
6. Reverse duplicate interest pair rejected.
7. Self-interest rejected.
8. Reuse of a confirmed provider transaction on another order rejected.
9. Negative payment amount rejected.
10. A live payment referencing a sandbox order rejected.
11. Overlapping subscription periods rejected.
12. Duplicate distinct-target usage in the same free window rejected.
13. A non-owner/non-bypass runtime role with no tenant context saw no profiles.
14. That role with agency A context saw only agency A's two profiles.
15. Its attempt to insert an agency B profile was rejected by RLS.
16. Catalog inspection confirmed enabled and forced RLS on all 17 tables.

Positive fixtures also demonstrated that the same email may exist in different agencies, Bengali text is accepted, and a renewal starting exactly when the previous subscription ends is allowed. Fixtures and the temporary runtime role were rolled back.

These tests establish SQL validity and the listed relational/tenant invariants. They do not establish application authorization, OTP behavior, gateway integration, legal compliance, payment reconciliation, quota locking under concurrent load, storage access, query performance at scale or an executable migration from the MVP. Those require the next implementation stages and their corresponding tests. The DDL deliberately grants no production runtime access.
