# Teamville — The Week, the Play Button & What to Ask

## How time works
The village is a **deterministic replay of one work week** (Mon 2026-06-08 09:00 → Fri 06-12 18:00 UTC). Every agent's position, current room, and speech bubble is a pure function of the **sim clock** — derived from the real event schedule (`data/seed/events.json`). Same time → same scene, every time (great for rehearsing the demo).

- **Scrubber** — drag to any moment in the week; the village jumps there.
- **▶ Play / ⏸ Pause** — auto-advances the clock at ~5 sim-minutes per real second, so the week plays out on its own; agents walk into meetings exactly when they occur. Dragging the scrubber pauses playback.
- **Idle gaps** — between scheduled meetings, scripted ambient scenes play (two agents walk to the kitchen / a desk, have a short coherent conversation, return). Authored, not random.

## Week schedule (when agents move where)
| When (UTC) | Room | Who | What |
|---|---|---|---|
| Mon–Fri 09:10 (30m) | Standup Room | all 6 | Daily sprint standup |
| Mon 12:00 | Focus Booth / Kitchen | ben+dana / tom+sara | 1:1 + metrics chat |
| Mon 13:00 | Kitchen | priya+marco | Atlas UX walkthrough |
| Mon 15:10 | Standup Room | priya+ben | Atlas risk review |
| Tue 10:00 (90m) | Whiteboard | marco+dana | GraphQL-drop decision |
| Tue 11:00 | Focus Booth | ben+tom | 1:1 growth/visibility |
| Tue 16:00 | Kitchen | dana+tom | vendor-API war council |
| Wed 12:00 (3h) | War Room | dana,tom,sara,ben | **API latency-spike incident** |
| Wed 14:00 | War Room | dana | hands off to Tom & Sara |
| Wed 17:00 | Focus Booth | ben+dana | incident debrief |
| Wed 18:00 | Kitchen | priya+sara | incident-data chat |
| Thu | Kitchen / Focus Booth | various | 1:1s + handoffs |
| Fri 09:10 | Standup Room | all 6 | Launch-day standup |
| Fri 11:00 (60m) | War Room | all 6 | Atlas launch retrospective |

## Scripted ambient scenes (idle filler, rotation)
1. **coffee_debrief** — Dana → Marco → kitchen: vendor API + GraphQL-drop banter → home.
2. **incident_thanks** — Tom → Sara → kitchen: thanks for the latency catch → home.
3. **risk_prep** — Ben → Priya: "Atlas risk review at 2?" → home.
4. **patch_sync** — Priya → Dana: connection-pool patch / platform freeze → home.
5. **design_check** — Marco → Tom: launch banner specs → home.
(Force one for a demo: `window.__teamville.startScene('coffee_debrief')` in the browser console.)

## What to ask each agent (grounded — these answer well)
- **Dana** (backend): "What's blocking the Atlas launch?" · "What happened in the Wednesday incident?"
- **Priya** (PM): "What's the status of the Atlas launch?" · "Why are partners hitting 404s?"
- **Marco** (designer): "Why did we drop the GraphQL API?"
- **Tom** (frontend): "How did you fix the latency spike?"
- **Sara** (data): "How bad was the latency spike?"
- **Ben** (manager): "What's in the Atlas risk register?" · "How did the team handle the incident?"
- **Honest-decline demo:** ask anyone "What's the recipe for chocolate cake?" → declines (all memories below the relevance threshold, zero LLM call).

## Demo tip
For the smoothest demo: pause at Mon 09:00, press ▶ briefly to show life, scrub to Mon 09:30 (standup cluster), scrub to Wed 14:00 (war-room incident), then click **Dana** and ask "What's blocking the Atlas launch?" for the cited money shot. See `docs/DEMO-SCRIPT.md`.
