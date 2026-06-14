# Teamville — Demo Video Script (≤ 5:00)

> Required submission artifact: a ≤5-minute demo video (YouTube or Vimeo).
> Carries the **User Experience & Presentation (15%)** score and showcases the
> 20/20/20 Accuracy / Reasoning / Reliability criteria. Lead with the outcome.
>
> **Before recording (every take):**
> 1. `npm run demo:reset` (seed.db → runtime.db, clears interviews)
> 2. `DB_PATH=db/runtime.db npm start` → open `http://localhost:3000`
> 3. Have VS Code open with the repo (for the MCP beat) — Copilot Chat in Agent mode.
> 4. Window at a clean size (the canvas is responsive; ~1440×900 looks good).
> 5. `GITHUB_TOKEN` in `.env` (the live interview needs it).

---

## Beat 1 — Hook (0:00–0:30)

**On screen:** the village, paused at Monday 09:00. Agents at desks; rooms labeled.

**Say:** "This is Teamville. Every character is a real teammate, and this village is a living replay of our work week. The Stanford *Generative Agents* paper put 25 AI characters in a fake town — we pointed that same memory-and-retrieval engine at a real work graph: meetings, Teams threads, decisions. And we made every answer *verifiable*."

**Do:** press **▶ play**. Let agents roam / walk around for ~3s so it reads as alive.

---

## Beat 2 — The week replays (0:30–1:10)

**Do:** drag the scrubber to **Monday 09:30**. The 6 agents walk through the doorway and cluster in the **Standup Room**; speech bubbles show the standup topic.

**Say:** "Drag the timeline and the week replays. 9:30 Monday — everyone's in standup. This isn't scripted animation; each agent's position is a deterministic function of the real schedule, so I can scrub anywhere and it's reproducible."

**Do:** scrub to **Wednesday 14:00**. Dana, Tom, Sara, Ben cluster in the **War Room** (the API-latency incident); Priya and Marco stay at their desks.

**Say:** "Wednesday afternoon — an incident pulls four people into the war room, while the PM and designer stay heads-down. The org chart, live."

---

## Beat 3 — The money shot: interview a teammate (1:10–3:00)

**Do:** click **Dana**. The interview panel slides in (village stays alive behind it). Type: **"What is blocking the Atlas launch?"** → Ask.

**Say (while it runs):** "Now I can interview any teammate about the week — answered from *their own memories*. Watch the pipeline: it embeds the question, scores Dana's memories by recency, relevance and importance — the exact formula from the paper — then drafts an answer, and a second model *judges* whether every claim is grounded before anything renders."

**On screen:** answer types in at the top: *"blocked by two issues — the platform team's deployment freeze and the degraded vendor API…"* with **citation chips [1][2][3]** and a green **✓ Grounded · Safe** badge.

**Do:** click a citation chip → it expands to Dana's actual source message + timestamp. Then expand **"How it retrieved this"** to show the score bars.

**Say:** "Every sentence is cited. Click a citation — there's the real message it's based on. And here's *how* it remembered: the retrieval scores, live. No source, no claim."

---

## Beat 4 — It knows what it doesn't know (3:00–3:40)

**Do:** in the same panel (or click Priya), ask something off-topic / unknowable: **"What's the recipe for chocolate cake?"**

**On screen:** a red **threshold line**; every candidate memory falls below it; the agent declines: *"I don't have reliable information about that."* — and **no LLM call fires**.

**Say:** "Ask something the week can't answer and it declines — and shows you why: every memory is below the relevance threshold. It refuses to guess. That honesty is the whole point — this is a tool you can trust in front of your team."

*(Optional, if time: ask an opinion question to show the judge BLOCK an ungrounded draft — "answer not shown, failed grounding check".)*

---

## Beat 5 — Second surface: MCP in VS Code (3:40–4:25)

**Do:** switch to **VS Code → Copilot Chat (Agent mode)**. Type: **"Use the teamville tools to ask Dana: What is blocking the Atlas launch?"** Copilot calls `teamville_interview` with question = *"What is blocking the Atlas launch?"*; the same cited answer comes back in chat.

> ⚠️ In the **web panel** (Beat 3), type ONLY the clean question — **"What is blocking the Atlas launch?"**. Do NOT include "using the teamville tools" there; that phrase is an instruction for *Copilot* (to call the MCP tools), and if pasted as the interview question it makes the agent assert an ungrounded claim about "tools" that the judge will (correctly) block.

**Say:** "It's not just a web app. Teamville ships an MCP server, so the exact same grounded, cited interview works right inside GitHub Copilot Chat — three tools, no UI needed. One memory engine, two surfaces."

---

## Beat 6 — Close (4:25–5:00)

**On screen:** the village (or the architecture diagram).

**Say:** "Teamville: the Stanford generative-agents model applied to a real work graph, made verifiable with citations and a grounding judge — onboarding, async standups, and knowledge that stays queryable when someone leaves. Built with GitHub Copilot, running on GitHub Models. Thanks for watching."

**On screen end card:** repo URL + "Built for the Microsoft Agents League — Creative Apps."

---

## Shot list / safety notes
- If the live interview is slow or rate-limited mid-take, pre-warm it once before recording (the answer is deterministic enough; the retry-on-block keeps it landing).
- Keep each interview to ONE question on camera to stay under 5:00.
- The honest-decline beat (Beat 4) is a differentiator — do not cut it; it's the Reliability (20%) story.
- Don't show the `.env` / token on screen.
