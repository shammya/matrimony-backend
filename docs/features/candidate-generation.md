# Slice 3.B: candidate generation

Status: **built 10 October 2026 (backend only, no screen yet).** Decisions were recorded the same day. Part of [discovery-loop.md](discovery-loop.md). The friend has not yet confirmed these product rules.

## Decisions (owner, 10 October 2026)

1. Only the opposite gender is proposed.
2. An unknown answer is **neutral**: it neither counts as met nor excludes a profile, and staff see it marked unknown.
3. **Both sides' preferences are checked** (two-way fit), see below.
4. N = 100 proposals per run (the assistant's call; one constant, easy to change).
5. Proposals refresh **automatically after staff approve a change that touches a profile's preferences or its first submission**, and staff can also press Find candidates at any time (the assistant's call).

## Two-way fit

For every candidate two scores are computed with the same rules: how well the **candidate fits the client's preferences** (forward) and how well **the client fits the candidate's preferences** (reverse). The saved result shows both, with the criteria that were met, not met and unknown in each direction. Ranking uses the total across both directions: fewest unmet first, then most met, then fewest unknown, then newest profile. A mismatch in either direction does **not** exclude the candidate (the agent reviews every list and may want a close case); it ranks lower and is flagged so staff can see who would probably say no and why. Complexion is ignored in both directions.

## What it does

When staff open a client, they press **Find candidates**. The system looks through the agency's published profiles, scores each against the client's partner preferences, and saves the best ones as **proposed** candidates for that client. Staff review them in slice 3.C. The client sees nothing until staff release it.

## Who is eligible (hard rules, never relaxed)

A profile is a candidate for a client only if all of these hold:

1. Same agency (also enforced by row-level security).
2. Its status is `active`, so it is approved and published. Drafts, waiting, rejected, paused, matched and closed profiles are never proposed.
3. It is not the client's own profile.
4. Its gender is different from the client's. *(Assumption, to confirm.)*
5. It has not already been proposed, released or removed for this client. A candidate staff removed never comes back.

Matching reads only **published** content, never a pending edit.

## How a candidate is scored

Each preference the client stated is one **criterion**. An empty preference means "does not matter" and is not a criterion. The score is the number of criteria the candidate meets out of the criteria stated, and the saved result lists which were met, not met and unknown, so staff can see why a profile was proposed.

| Preference | Candidate meets it when |
| --- | --- |
| Age range | age on today's date is within the range |
| Height range | height is within the range |
| Religion, sect, marital status | the candidate's value is in the list |
| Minimum education | the candidate's highest degree is at or above it (the list is ordered) |
| Occupation type, profession | the candidate's value is in the list |
| Districts | current district is in the list |
| Income range | the candidate's income band is within the range |
| Minimum family status | at or above it |
| Religious practice, diet, smoking, children, relocation | the candidate's value is in the list |
| **Complexion** | **ignored: never a criterion** (owner's decision) |

A criterion the candidate has not answered is **unknown**: it neither counts as met nor excludes the profile, and staff see it marked unknown.

Candidates are ranked by criteria met, then by number unknown (fewer first), then by newest profile. Only the top **N** are saved (proposal: N = 100, so staff can choose a cap of 50 from them).

## When it runs

On demand, when staff press Find candidates, and again whenever they press it later. Running again adds new proposals and refreshes scores of the ones still proposed. It never touches released or removed candidates and never creates a duplicate. Nothing runs automatically, so there are no background jobs and no stale lists.

## Data (migration 013, additive; applied)

One table, `client_candidates`: agency, client profile, candidate profile, `state` (`proposed`, `released`, `removed`), score, met, unmet and unknown criteria, proposed time, and who changed the state and when. One row per client and candidate (unique), tenant-scoped with row-level security like the other tables. 3.B only creates `proposed` rows; 3.C moves them to `released` or `removed` and adds the per-client cap and visible fields.

## Access

Only admins and agents who may see the client (an admin sees all; an agent only their own clients, as for clients today). A member and any other agency get a 404. The client never receives these rows in any response.

## Endpoints (proposed)

- `POST /api/v1/staff/clients/{profileId}/candidates/generate`: runs the matching, returns the proposals.
- `GET /api/v1/staff/clients/{profileId}/candidates?state=&limit=&after=`: lists them, one page at a time, with a safe preview of each candidate (name, age, profession, district, photo thumbnail if approved) and the criteria result. No contact details, no internal notes.

## Failure and concurrency

- Two staff pressing Find candidates at once: the unique row per client and candidate makes the second a refresh, not a duplicate.
- A candidate whose profile becomes paused or closed while proposed: it is skipped at release time (3.C) and on the next run.
- The matching query is bounded (a limit and a time limit) and runs inside one transaction with the agency's row-level security switched on.

## Tests

- Unit: each criterion (ranges, ordered education, lists, unknown), ranking, complexion ignored.
- Real PostgreSQL: only active, same-agency, other-gender, not-own profiles appear; a removed candidate never returns; two runs at once leave one row each; another agency sees nothing; an agent cannot reach a colleague's client; a member gets 404.

## Questions to confirm

1. **Gender rule:** propose only the opposite gender? (Assumed yes.)
2. **Unknown answers:** neutral and shown to staff, as drafted, or should a missing answer count against the candidate?
3. **Two-way fit:** should a candidate whose own preferences exclude the client rank lower? (Not in 3.B; can be added as a flag staff see.)
4. **Size:** N = 100 proposals per run, enough?
5. **Trigger:** on demand only, as drafted, or also automatically when a client's preferences change?
