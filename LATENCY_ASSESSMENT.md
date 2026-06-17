# Omnam Frontend — Latency & "Agent Brain" Assessment

**Goal:** sub-1s avatar responses, with the world's smartest travel-agent brain running the orchestration.
**Scope:** end-to-end voice turn — user stops talking → avatar starts speaking.
**Basis:** the per-session latency logs in `logs/`, the orchestration code (`/api/orchestrate`, `lib/orchestrator/*`), the HeyGen LiveAvatar SDK, and the OpenAI/Anthropic call sites.

---

## 1. Executive Summary

- The two costs that matter are the **LLM call (~64% of measured latency)** and **HeyGen TTS first-audio (~32%)**. Everything else (regex, network, server) is noise.
- The whole pipeline is **strictly sequential and non-streamed**: the LLM response is fully awaited (`await response.json()`) before a single character reaches HeyGen. The LLM's ~1.2s and HeyGen's ~0.6s stack instead of overlapping.
- There is **no prompt caching**, and the prompt is built in a way that *can't* cache (full transcript + `new Date()` sit in the system-prompt prefix). A small model spends ~1.2s mostly on **input-token processing (time-to-first-token)**, not generation.
- **The LLM is already the brain.** On ~80% of turns (13/16 in the sampled session) the spoken answer is LLM-authored. The large regex/state-machine layer is mostly *routing + fallback*, contributing ~1ms. **Eliminating regex will not improve latency.**
- **STT is currently unmeasured.** HeyGen owns both STT and TTS; the rolling summary starts the clock at transcription, hiding the VAD/STT finalization time. This is the one blind spot to close before drawing final conclusions.
- Biggest wins, in order: **(1) stream LLM → sentence-chunk into HeyGen, (2) prompt caching + transcript trimming, (3) reduce client preflight, (4) instrument STT.**

---

## 2. Measured Latency Breakdown

From `logs/session-2026-05-23_00-35-26-*.log`, 16-turn rolling summary (transcription → first audio):

| Segment | avg | max | % of budget | Notes |
|---|---|---|---|---|
| Intent classify (regex) | **1 ms** | 3 ms | ~0% | Already negligible; only a hint to the LLM |
| Client preflight | 282 ms | 411 ms | 15% | Client-side work *before* the request is sent (14/16 turns) |
| Network → server | 13 ms | 19 ms | <1% | |
| Server pre-LLM | 2 ms | 4 ms | <1% | |
| **LLM call** | **1207 ms** | **1893 ms** | **64%** | The dominant cost (13/16 turns) |
| Server post-LLM | 3 ms | 9 ms | <1% | |
| Network ← server | 35 ms | 113 ms | ~2% | |
| repeat() dispatch | 3 ms | 8 ms | <1% | |
| **HeyGen TTS first audio** | **596 ms** | **754 ms** | **32%** | Every spoken turn |
| **TOTAL** | **1883 ms** | **2928 ms** | | Target is <1000 ms |

**Critical path is sequential:** preflight → LLM (fully awaited) → HeyGen TTS. The LLM and TTS do not overlap.

**Models in use (already migrated to the fast tiers):**
- `PROFILE_COLLECTION` → Anthropic **`claude-haiku-4-5`** (`max_tokens: 360`, `temperature: 0.2`).
- All other stages → OpenAI **`gpt-5.4-nano`**.
- Both land ~0.8–1.9s with tiny output (≤500 chars), which points at **input processing, not generation** — i.e. the prompt size, not the model.

---

## 3. Where the "Brain" Lives (regex vs LLM, per stage)

The system is a **hybrid**: a pure state machine (`lib/orchestrator/journey-machine.ts`, ~1044 lines) defines which actions are *legal* per stage; the LLM picks one action and writes the spoken words on nearly every voice turn. ~35 hardcoded `DEFAULT_SPEECH` strings exist as a **fallback** — the executor (`useJourney.ts:608-653`) always prefers the LLM's text and only renders a canned string when the LLM result is absent.

| Stage | LLM on the turn? | Speech author |
|---|---|---|
| `PROFILE_COLLECTION` | Mostly **yes**. High-confidence answers caught by the deterministic fast-path (`profileFastPath.ts`, on by default) skip the LLM; anything ambiguous/conversational/skip-ahead → LLM | LLM, except fast-path hits |
| `VIRTUAL_LOUNGE` | **Yes** — every voice intent calls orchestrate | LLM (rendered fallback) |
| `HOTEL_EXPLORATION` | **Yes** — all USER_INTENT turns | LLM, except `list_amenities` (data-grounded render) |
| `AMENITY_VIEWING` | **Yes** | LLM, except `list_amenities` |
| `ROOM_SELECTED` | **Yes** | LLM (rendered fallback) |
| `DESTINATION_SELECT` | Voice **gated off** — UI taps only | Deterministic |
| `END_CONFIRMING` / `LOUNGE_CONFIRMING` | **No** — yes/no regex-short-circuited | Deterministic |
| Global "I'm done" / "back to lounge" | **No** — regex short-circuit | Deterministic |
| UI taps (unit select, card tap, hotel pick) | **No** — not voice turns | Deterministic templates |
| Idle re-engagement | **No** | Deterministic |

**Turns that skip the LLM entirely are narrow:** yes/no confirmations, explicit end/lounge commands, pure UI taps, idle nudges, and the confident slice of profile answers. **Everything that is an open-ended spoken request goes through the LLM (~80% of turns).**

**Implication:** optimizing the LLM path is optimizing the dominant path, not an edge case. The regex layer is for routing/reliability, not speed (~1ms); removing it changes latency by zero.

---

## 4. Root Causes (why the LLM call is ~1.2s)

1. **No streaming.** Both providers are called with `fetch` + `await response.json()` (`app/api/orchestrate/route.ts:2166` Anthropic, `:2329` OpenAI). The full response is awaited before HeyGen starts, so 1207ms + 596ms stack sequentially instead of overlapping.

2. **No prompt caching, and the prompt can't cache.** The Anthropic call sends `system: systemPrompt` with no `cache_control`. The prompt prefix contains **silent cache invalidators**:
   - `const today = new Date().toISOString()` interpolated into the prompt.
   - the **entire conversation transcript** concatenated into the `system` string.
   Caching is a prefix match (render order `tools → system → messages`); with volatile content in the prefix, nothing would ever hit even if a breakpoint were added. Haiku 4.5's minimum cacheable prefix is 4096 tokens (you're well over). Cache reads cost ~0.1× and, more importantly, **skip re-processing those tokens → far lower TTFT**.

3. **Oversized, per-turn-rebuilt prompt.** `buildSystemPrompt` reassembles the full persona, every per-stage tool contract with worked examples, the amenity catalog, the reconstructed-profile block, and up to 24 transcript turns — every turn. Small output (≤500 chars) confirms the ~1.2s is input processing.

4. **Client preflight (282ms, 15%)** is spent client-side before the request is even sent (body assembly across three stores, possible debounce in `orchestrateLLM` callers). Largely recoverable.

5. **Architectural complexity tax.** 1044-line reducer + 2364-line `useJourney.ts` wiring + huge per-stage prompts + **two LLM providers** + regex + deterministic-speech duplication + fast-path + speech-mutex. This is spread across two providers with zero caching/streaming — complexity that is itself a latency and scaling liability.

---

## 5. HeyGen / STT / TTS

- **TTS first audio: 596ms avg** — real, and the second-biggest segment. The SDK (`LiveAvatarSession.repeat(message: string)`) takes a complete string but **can be called repeatedly**, so we can stream sentence-by-sentence and start TTS on the first clause while the LLM is still generating. The 596ms doesn't vanish but moves off the LLM's tail.
- **STT finalization is NOT in the summary.** `debug.ts` defines `sttFinalizationMs` (HeyGen `USER_SPEAK_ENDED → USER_TRANSCRIPTION`) but the rolling summary starts at transcription. Since HeyGen owns STT *and* TTS, the avatar stack could be a bigger share than 32% once STT is counted. **This is the measurement gap to close first.**
- There is a `CUSTOM` mode path that uses ElevenLabs (`/api/elevenlabs-text-to-speech` → `repeatAudio`), giving an alternative TTS path if HeyGen's first-audio time proves to be the floor.

---

## 6. Assessment of the Original Assumptions

| Assumption | Verdict |
|---|---|
| "Eliminate regex, run everything through realtime LLMs" | **Won't help latency** (regex is 1ms and already just a hint). Valid as a *smartness/simplicity* goal, not a speed one. |
| "Shorten/compress transcripts and payloads" | **Correct**, but the bigger lever is **prompt caching** (a frozen, cached prefix). Trimming the transcript is a complementary win on the uncached suffix. |
| "Stream to the LLM and to HeyGen" | **Correct — the single biggest win.** Today everything is fully sequential and non-streamed. |
| "HeyGen adds a lot of overhead" | **Partly true** — TTS is 32%; STT is unmeasured. Largely *hideable* via streaming + a short-acknowledgment trick. |
| "Haiku might not be the best model" | **Probably not the problem.** The ~1.2s is the uncached mega-prompt, not the model. Haiku 4.5 with a warm cache is a strong fit; confirm via a head-to-head after caching+streaming land. |

---

## 7. Recommendations (prioritized)

### Tier 0 — No-regret, do first
- **Surface STT in the rolling summary.** Add `sttFinalizationMs` and `userSpeakEnded → transcription` to the per-session breakdown (already captured per-turn in `debug.ts`). Removes the last blind spot before we optimize on complete data.

### Tier 1 — Overlap the two big segments (attacks ~1803ms of LLM+TTS)
1. **Stream the LLM response.** Use SSE; parse the tool-argument speech field incrementally (Anthropic `input_json_delta` / OpenAI streamed function-call args). Put the spoken field first/alone in the tool schema so it streams before anything else.
2. **Sentence-chunk into HeyGen.** Buffer to a sentence/clause boundary and call `repeat()` per chunk so TTS begins while the LLM is still generating. This collapses the sequential 1207 + 596 into roughly `max(LLM tail, TTS)`.
3. **Instant-acknowledgment trick.** The moment the tool name is known (~150ms), fire a 2–3 word `repeat("Of course—")` while the substantive sentence streams. Drops *perceived* latency under 1s even when full audio takes longer.

### Tier 2 — Cut LLM time-to-first-token (attacks the 1207ms)
4. **Restructure for prompt caching.** Freeze a stable prefix (`tools` + persona/rules/stage-contract/catalog in `system`) with a `cache_control` breakpoint at its end. Move everything volatile (today's date, transcript, reconstructed profile, the user message) into `messages` *after* the breakpoint. Verify with `usage.cache_read_input_tokens > 0`.
5. **Pre-warm the cache** on session start with a `max_tokens: 0` request so the first real turn isn't a cold write.
6. **Trim the transcript** to ~8–12 turns plus the structured profile (the authoritative profile already exists; the LLM doesn't need 24 raw turns to re-derive it).

### Tier 3 — Smaller segments and consolidation
7. **Investigate client preflight (282ms).** Trace what happens between transcription and `fetch` in `orchestrateLLM` and its callers; expect ~150ms of easy wins.
8. **Consolidate to one LLM provider** (head-to-head after caching+streaming) so caching/streaming logic lives in one path. Anthropic caching is explicit and predictable; Haiku 4.5 is a strong fit.

### Strategic — "smart + simple + fast"
9. **Move toward LLM-as-single-brain with a thin guardrail.** Since the LLM is already the brain on ~80% of turns, making it the brain on *all* turns — once streaming+caching make a turn cheap — lets us delete the parallel deterministic-authoring machinery (regex / fast-path / rendered-speech triplication), keeping the state machine only as a legal-action guardrail and a fallback for LLM-down / zero-utterance UI taps. This increases smartness (handles any conversational twist, graceful "I don't have that, but here's what I can do"), reduces complexity, and improves latency. **This is a larger architectural bet and should be decided explicitly before implementation.**

---

## 8. Expected Outcome

With Tier 1 + Tier 2:
- Effective path ≈ preflight (~100ms) + LLM time-to-first-clause on a warm cache (~400–500ms) + HeyGen first audio (~596ms, now the only thing gating audio) ≈ **1.1–1.3s real**, with **perceived latency under 1s** via the acknowledgment trick — down from **1.9s avg / 2.9s p-max** today.
- Strict sub-1s on *real* first audio additionally needs shaving HeyGen (shorter first clause, or the ElevenLabs `repeatAudio` path) and confirming the STT contribution.

---

## 9. Open Decisions

1. **Architecture direction:** keep the constrained hybrid and bolt on streaming+caching, **or** move to LLM-as-single-brain with a thin guardrail (Recommendation #9)?
2. **Provider:** consolidate on Claude Haiku 4.5, keep both with streaming+caching each, or decide after a measured head-to-head?
3. **TTS:** hide HeyGen's 596ms via streaming only, or also benchmark the ElevenLabs `repeatAudio` path in parallel?

*Immediate next step regardless of the above: add STT instrumentation (Tier 0) so the next session log shows the full STT / LLM / TTS split.*
