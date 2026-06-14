# Teamville — Submission Checklist (Microsoft Agents League, Creative Apps)

Deadline: **June 14, 2026, 11:59 PM PT.** Submit via the Hackathon platform/portal.

## Required artifacts

- [ ] **Working project** — public GitHub repo with source. (Build: `npm install` → add `GITHUB_TOKEN` to `.env` → `npm run ingest` → `npm run demo:reset` → `npm start`.)
  - [ ] Repo is **public**.
  - [ ] `db/seed.db` committed (the populated baseline — 144 memories) so judges don't have to re-ingest. *(You handle git.)*
  - [ ] `.env` is gitignored; `.env.example` documents `GITHUB_TOKEN`.
- [ ] **Demo video ≤ 5:00** on YouTube or Vimeo — see `docs/DEMO-SCRIPT.md`. Lead with the outcome; include the honest-decline beat.
- [ ] **Project description** — features, problem solved, tech used. (README.md covers this; paste/adapt into the portal.)
- [ ] **Architecture diagram** — `docs/architecture.png` (+ `docs/architecture.mmd` source). Shows GitHub Models + the interview pipeline + MCP + the Work IQ dashed connector.
- [ ] **Team member info** incl. **Microsoft Learn usernames** (if applicable) — fill in at submission.

## Track compliance (Creative Apps)

- [x] **Required tool = GitHub Copilot** — used during development (mention this in the description/video).
- [x] Runtime LLM = **GitHub Models** (`text-embedding-3-small`, `gpt-4o-mini`, `gpt-4o`) on a free token — no Copilot subscription needed.
- [x] Genuinely creative app providing value (the village metaphor + interviewable, verifiable colleagues).
- Work IQ: documented future connector (not required for this track; needs M365 Copilot license). Honest dashed box in the diagram.

## Scoring-aware polish (rubric: 20/20/20/15/15/10)

- [x] **Accuracy (20%)** — answers grounded in retrieved memories; cited.
- [x] **Reasoning (20%)** — the pipeline stepper + live retrieval score bars surface the multi-step thinking in the UI and video.
- [x] **Reliability & Safety (20%)** — grounding judge gates every answer; honest threshold-decline; draft-retry-on-block; judge-before-render (no on-camera retraction).
- [x] **UX & Presentation (15%)** — game-like village, rooms, roaming, responsive, answer-first panel, accessibility pass.
- [x] **Creativity (15%)** — Generative-Agents-paper engine on a real work graph; two surfaces (web + MCP).
- [ ] **Community vote (10%)** — **post early in Discord** (aka.ms/agentsleague/discord) with a screenshot/gif; ask for votes. Most competitors skip this — 10% nearly free.

## Pre-submit smoke (run once)

- [ ] `npm test` green; `npm run typecheck` clean (backend + frontend).
- [ ] `npm run demo:reset && npm start` → `http://localhost:3000`: village loads, scrub to standup clusters agents, click Dana → cited answer + ✓ verdict, off-topic question declines.
- [ ] MCP: `docs/MCP-SETUP.md` steps work in VS Code Copilot Chat (3 tools, cited interview).
- [ ] Demo video uploaded + link works (unlisted is fine).

## Accessibility Award (separate prize, optional upside)
- [x] Keyboard nav, ARIA roles/labels, focus-visible styles, reduced-motion, off-screen screen-reader log on the interview UI. Worth a sentence in the description if you also enter for the Accessibility Award.
