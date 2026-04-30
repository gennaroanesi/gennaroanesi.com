# Building a natural-language home hub with Claude

A bespoke household app I built for my wife and me. Tasks, bills, calendar events, reminders, documents, photos, trips, pets, and Home Assistant device control — all sharing one schema, reachable from three surfaces: WhatsApp, a Next.js web app, and a native iOS app. A Claude-powered agent ("Janet") is one of the input modes. This writeup covers the architecture, the one design decision that turned out to matter most, and the war stories worth retelling.

## What it is

Not a chatbot. A small production app that two people use every day, where one of the input modes happens to be a natural-language agent. ~25 data models, ~40 agent tools, ~12 Lambdas (some scheduled, some on-demand), ~$8/month to run.

Domain shape gives a sense of scope:

- **Tasks** with recurring occurrences (an explicit `homeTaskOccurrence` table — not a rolling-`dueDate` hack)
- **Calendar events** with ICS feed sync against external calendars
- **Reminders** with full rrule recurrence + a 5-minute sweep that fires push notifications
- **Documents** vault with Duo-gated downloads on web, Face ID on mobile (Duo as fallback)
- **Photos** with Rekognition face detection + per-person face enrollment
- **Trips** with legs and reservations (and a wall-clock-time convention for flight schedules — see below)
- **Pets** with medications and vaccines
- **Home Assistant** devices, state cached locally, controllable from any surface

The agent reads and writes against this schema via tools. It's not the only writer — the web and mobile UIs are full first-class clients, and they all converge through the same custom mutations.

## Architecture

```
WhatsApp        Web (Next.js)         Mobile (Expo / iOS)
    │                │                       │
    │                └─────── Cognito ───────┘
    │                            │
    ▼                            ▼
Bot service              AppSync (GraphQL) ◀── custom mutations
(Fargate, Baileys                │           + invokeHomeAgent
 image in ECR)                   ▼
    │                        DynamoDB
    │                            ▲
    └── invokeHomeAgent ──▶  Agent Lambda  ──▶ Anthropic API
                                  │
                                  ├──▶ Home Assistant REST
                                  └──▶ S3 (photos, docs, attachments)

Scheduled Lambdas (EventBridge):
  · recurring-task sweep    · reminder sweep (5 min)
  · ICS feed sync (15 min)  · HA device state sync
  · daily summary composer  · face detector (DDB stream)
```

**Three surfaces, one mutation.** The WhatsApp bot is a thin Baileys-based service on Fargate (image in ECR) that handles WA's protocol quirks — group-chat support is why I'm not using the official WhatsApp Business API. It forwards user input to `invokeHomeAgent`, the same AppSync mutation the web and mobile chat UIs call. Cross-surface consistency lives in the data layer, not in shared client code: actions like completing a recurring task go through a custom mutation (`taskOccurrenceAction`) that all three surfaces invoke, so "complete this task" means the same thing whether it came from a swipe on iOS, a checkbox on the web, or the agent saying "I'll mark that done."

**Auth is real.** Cognito groups (`home-users`, `admins`) gate every mutation. A post-confirmation Lambda auto-links new Cognito users to `homePerson` rows so the agent can attribute tool calls to the right human. For HIGH-sensitivity actions (document downloads today, automated unlock-on-arrival in the planned v2 device-control path), the system uses defense-in-depth: Duo Push on web, Face ID on mobile (with Duo as a fallback when Face ID isn't enrolled), gating the same backend act with whichever second factor that surface can offer.

A note on terminology: this is **tool use** (function calling within an Anthropic API request), not MCP. Tool use is the right fit when the agent is single-purpose and tightly coupled to one app; MCP would make sense if I wanted to point Claude Desktop or another client at the same tool surface. For one app and one household, the protocol overhead isn't worth it.

## The thing that mattered: parallelizing tool execution

The agent sits behind an AppSync custom mutation. **AppSync caps SSR responses at 30 seconds** — that ceiling, not Lambda's 15 minutes, is what the agent has to fit under.

Sequential tool execution worked fine for one-shot commands ("turn off the kitchen lights" — about 3-4 s end-to-end). It broke as soon as a single message triggered a routine. "Good morning" maps to four or five tool calls — open the bedroom blinds, set the thermostat, start the coffee, unmute the kitchen speaker. Sequentially that's 12-20 s and uncomfortably close to the cap. It tripped over a few times.

The fix was to fan out: when Claude returns a batch of tool calls, dispatch them in parallel and `Promise.all` the results. End-to-end latency dropped from sum-of-latencies to max-of-latencies. Compound commands now finish in the same 3-5 s as single ones.

The composability surprise: Claude is genuinely good at returning batched tool calls when the user's intent maps to parallel actions. I didn't prompt-engineer this — it just does it. What I had to engineer was the *execution* side: the agent has to know which tool calls are safe to parallelize and which have ordering dependencies (rare in home control, but they exist when one action's result feeds the next).

A second surprise was vision. Sending a photo into the WA chat — say, a screenshot of a boarding pass — flows through the same mutation: Baileys downloads the media, the bot uploads it to S3, the agent passes Claude image content blocks alongside the text, and Claude pulls the trip out and creates the trip + leg rows in one turn. Multi-turn vision works because conversation history carries the images. This was a much smaller engineering lift than I expected for the product surface area it unlocked.

## One scar: two timezone conventions

The schema has datetime fields that follow two different rules, and which applies depends on the model:

- **Real UTC** — "a moment everyone experiences together." Calendar events, reminders, task due dates. Stored as ISO 8601 in actual UTC; rendered in the viewer's local timezone.
- **Wall-clock ISO** — "the local clock at a physical location, regardless of viewer." Trip leg depart/arrive times, hotel check-in/check-out. A 4:22 PM Rome departure is stored as `2026-07-02T16:22:00.000Z` regardless of where the entry was made. The `Z` is syntactic, not UTC. These values **must never round-trip through `new Date()`**.

Mixing them is the easiest way to break a feature. Every dev session that touches a datetime field threatens to re-break it; one fix on web shipped UTC math against a wall-clock field and a flight time silently shifted by five hours. This is now a documented memory rule that any contributor (LLM or human) reads before touching the relevant files, alongside helpers like `parseLegIso`, `formatLegTime`, and `legIsoToLocalDate` that keep wall-clock fields out of `Date` entirely.

The lesson — for an AI codebase or any other — is that conventions encoded only as convention rot fast. Either lift them into types, or write them down in a place every contributor reads before they touch the relevant code. Mine is the latter; the former is on the roadmap.

## What's still rough

- **Tool schemas are hand-maintained.** ~40 tools across ~10 domain models, hand-written. A generator that introspects the schema would save real time but hasn't earned its keep yet.
- **No audit trail beyond CloudWatch.** Fine for a household, would not survive multi-tenant.
- **Two timezone conventions, soft-enforced.** Per above. Wrapper types (`UTCMoment`, `LocalWallClock`) would harden this; the friction of bolting them onto an existing schema hasn't won yet.
- **No real planner.** Claude handles compound commands well by batching, but there's no explicit reasoning step about ordering. I've sidestepped a few known-ordered cases with prompt examples rather than a planner. Most home-control commands are commutative; the few that aren't are infrequent enough to live with.
- **Conversation memory is shallow.** Last 5 turns per chat (5 user + 5 assistant), in-process on the WhatsApp bot, scoped per *chat* so household members can build on each other's commands. Resets on container redeploy. Crude, but covers the common case.

## Honest assessment

This is internal tooling — built for one household, not for a market — and the scope is part of what makes it work. No multi-tenant auth, no support for arbitrary smart-home stacks, no other people's edge cases. What I get back is a system I actually use across three surfaces every day, and operational learnings that come from running it: where the latency lives (AppSync cap, not Lambda), what fails when complexity grows (datetime conventions, cross-surface consistency), what the API rewards (parallel tool calls, batched intent), what's worth automating (the data layer's mutations) versus hand-maintaining (the agent's tool schemas, for now).

Building it taught me more about production AI infrastructure than any tutorial. Operating it taught me something different: that the hard parts of an AI app are mostly the same as the hard parts of any app — schemas, conventions, time math, cross-surface consistency, defense in depth — and the LLM is one well-behaved component among many.
