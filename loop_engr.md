# LOOP ENGINEERING 101

> The biggest shift in AI prompting yet. Design a loop, get agents building while you sleep. A layman's guide to /loop.

---

## 01 — wtf is a Loop?

- Agents that **prompt themselves** and skip manual iterations.
- **Before:** prompt → respond — you iterate — repeat
- **With loops:** design a loop → agent returns a **finalized result**

> "I don't prompt Claude anymore. I have loops running that prompt Claude. My job is just to write loops." — **Boris Cherny**, who built Claude Code

---

## 02 — Loop Anatomy

> _6 parts_

1. **Trigger:** start via `/schedule + /loop`; runs on interval or self-paces
2. **Execution:** Claude reads state, acts, outputs. No manual input
3. **Verifier:** tests / build / screenshot / `/goal` grades after every turn
4. **Stop Rules:** **success** + **failure** stops + token budget. Be explicit
5. **Memory:** markdown progress file to check + roll back
6. **Skills (CLAUDE.md):** frozen instructions. Keep short, lines cost tokens

```bash
# optimal loop structure
TRIGGER  - every 15min / on PR comment / on CI fail     DOER  - Claude works the task
CHECKER  - separate model grades output                  STOP  - tests green / 10 iters / $5
MEMORY   - progress.md updated each run                  SKILLS - CLAUDE.md read on start
```

---

## 03 — Prompting for Loops

- A prompt is an **instruction** (what to do). A loop is a **final condition** (when to stop). 3 parts: **end state · scope · stop rule**
- **Prompt:** "Fix the failing tests in the auth module."
- **Loop:** "/loop all auth tests pass and coverage is above 80%"

> /loop [verifiable end state/time], only touching [scope], stop after [X] constraints, use [X] Skills, use verifier agents for [x] checkpoint, keep a memory file of all work.

- **CLAUDE.md** = briefing read before every run (stack, rules, preferences). Keep it short

---

## 04 — /loop Pro Tips

- **Start with `/goal`** before `/loop`
- **Match effort:** high default, xHigh/Max for complex
- **Always cap** iterations + dollar budget
- **Not just code:** writing, research + more
- **Spend time on the deliverable**
- **Subagents** each get a fresh context window
- **Compact early** before long sessions

---

<sub>ai.edge — AI articles 2-3x / week — newsletter.aiedgehq.co</sub>
