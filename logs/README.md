# Latency logs

Per-session, human-readable timing logs for the user → avatar voice loop.
One file per HeyGen session, written by `app/api/log-latency/route.ts`.

Two backends, same file format:

- **Local dev** (`NODE_ENV !== "production"`) → `./logs/session-*.log` on disk. This directory is gitignored except this README and `.gitkeep`.
- **Vercel production** → public Vercel Blob (`BLOB_READ_WRITE_TOKEN` env var, attached automatically when the Blob store is connected to the project). Each session is one blob with a public, unguessable URL.

## When they're written

Each user→avatar turn fires one POST from `flushLatencyToFile()` in
[`lib/debug.ts`](../lib/debug.ts) the moment the avatar starts speaking.
The server caches all entries for the session in memory and **rewrites the
whole file each turn** so the running summary at the top is always up to
date.

## Finding logs in production

Three ways to get a session log URL on Vercel:

1. **`vercel logs`** (or the dashboard's runtime logs view) — every fresh
   session writes one `[log-latency] session log: https://…blob.vercel-storage.com/session-…log`
   line on its first turn.
2. **`GET /api/log-latency`** — returns JSON `{ sessions: [{ url, pathname, uploadedAt, size }] }`
   for the newest 10 sessions, sorted newest first.
3. **Browser DevTools → Network tab** — every POST response from the client
   contains `{ ok: true, url, pathname }`.

Open any URL in a browser to see the formatted log as plain text.

## Edge cases

If the in-memory cache is gone but the file/blob already exists (dev-server
restart, or Vercel lambda instance churn mid-session), subsequent turns are
appended in plain mode with a one-line note flagging that the running
summary above is now stale.

## Privacy note

Vercel Blob URLs are unguessable but **publicly readable by anyone with the
URL**. These logs contain user transcripts and avatar responses — treat any
URL you share like a credential.

## File naming

```
session-2026-05-06_14-22-08-9f3a1c2b.log
        └─── start time ───┘ └ short id ┘
```

The first turn of a session creates the file, using its wall-clock
timestamp and the first 8 chars of the client-minted `sessionId`.
Subsequent turns are appended to the same file (matched by sessionId
suffix). Only the **newest 10** session files are retained — older ones
are deleted on each new session start.

## File layout

Top to bottom: session header → running summary → every turn block (oldest
first). The summary is rebuilt from the in-memory entry cache on each turn.

```
================================================================================
SESSION START  ·  2026-05-06 14:22:08.412
sessionId=9f3a1c2b-ac2b-4479-99ac-50f0812ab5cd
================================================================================

================================================================================
RUNNING SUMMARY  ·  6 turns  ·  last updated 2026-05-06 14:31:02.103
--------------------------------------------------------------------------------
  STT finalization (HeyGen)             avg  720 ms   max 1100 ms  ██████████████
  Intent classify (regex)               avg    1 ms   max    5 ms
  Client preflight                      avg  280 ms   max  418 ms  █████
  Network  → server                     avg    9 ms   max   11 ms
  Server pre-LLM                        avg    1 ms   max    2 ms
  LLM call                              avg 1500 ms   max 2945 ms  ██████████████████████████████
  Server post-LLM                       avg    2 ms   max    6 ms
  Network  ← server                     avg   10 ms   max   24 ms
  repeat() dispatch                     avg    1 ms   max    3 ms
  HeyGen TTS first audio                avg  540 ms   max  694 ms  ███████████
                                      ─────────
  TOTAL  (user-speak-end → audio)       avg 2400 ms   max 3000 ms  ████████████████████████████████████████

  slowest segment on average: LLM call (avg 1500 ms)
================================================================================

================================================================================
TURN  ·  2026-05-06 14:22:08.412  ·  stage=PROFILE_COLLECTION  ·  pathway=orchestrate
turnId=9f3a1c2b-...
user:   "i want a hotel near como"
avatar: "Lake Como is gorgeous in spring — let me ask a couple of things..."
--------------------------------------------------------------------------------
  STT finalization (HeyGen)             420 ms  ████████
  Intent classify (regex)                 3 ms
  Client preflight                        8 ms
  Network  → server                      42 ms
  Server pre-LLM                         18 ms
  LLM call (anthropic claude-haiku-4-5) 890 ms  █████████████████
  Server post-LLM                        11 ms
  Network  ← server                      38 ms
  repeat() dispatch                       2 ms
  HeyGen TTS first audio                612 ms  ████████████
                                      ────────
  TOTAL  (user-speak-end → audio)      2044 ms  ████████████████████████████████████████

  Avatar speech duration               3120 ms

  llm: provider=anthropic model=claude-haiku-4-5
================================================================================
```

Each segment row in the summary shows `avg` and `max` (in ms) plus a
coverage suffix like `(4/6 turns)` if some turns didn't measure that
segment (e.g. fast-path turns with no LLM call). The bar chart visualizes
`avg` against the same 50 ms-per-char scale as the per-turn blocks.

Each bar character ≈ 50 ms, capped at 40 chars. The TOTAL bar is the
headline number — typical voice latency users feel. Segments with no
timing (e.g. partial turn) are dropped from the block.

## Field map

| Block line | Source | Notes |
|---|---|---|
| `STT finalization` | HeyGen `USER_SPEAK_ENDED` → `USER_TRANSCRIPTION` | HeyGen-side VAD + STT. Often the largest single segment. |
| `Intent classify` | After `classifyIntent()` in `useJourney` | Synchronous regex; should be ≤5 ms. |
| `Client preflight` | Intent classified → `fetch()` issued | React render + `useJourney` decision logic. |
| `Network → server` | Client `fetch` start → server `requestReceived` | Localhost: usually <20 ms. |
| `Server pre-LLM` | `requestReceived` → `llmCallStart` | Prompt assembly, tool-schema build. |
| `LLM call` | `llmCallStart` → `llmCallEnd` | Anthropic (PROFILE_COLLECTION) or OpenAI (everything else). |
| `Server post-LLM` | `llmCallEnd` → `responseSent` | Tool-args validation, decision-envelope build, log emission. |
| `Network ← server` | `responseSent` → client `await res.json()` resolved | Localhost: usually <20 ms. |
| `repeat() dispatch` | Client response → `session.repeat()` called | Tool dispatch + `processIntent`. |
| `HeyGen TTS first audio` | `repeat()` → `AVATAR_SPEAK_STARTED` | HeyGen warmup + TTS first frame. Second-largest segment after STT typically. |

## Caveats

- Chat-mode turns produce shorter blocks: `STT finalization` and `HeyGen TTS first audio` are dropped because no audio events fire.
- `pathway` distinguishes how the turn was dispatched — `orchestrate`, `fast-path`, `regex-shortcircuit`, `fallback`, etc. Useful for filtering out non-LLM turns when comparing models.
- The structured (JSON) form of every entry is also kept in memory at `window.__omnamDebug.latencies()` for the last 20 turns.
- Logs are **not** rotated within a session — a long session produces a long file. The 10-file retention bounds total disk use across sessions.
