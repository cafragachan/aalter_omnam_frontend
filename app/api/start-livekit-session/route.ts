import { AccessToken, RoomConfiguration } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Stage 4 — LiveKit session init route
// ---------------------------------------------------------------------------
//
// Mirrors the public contract shape of the HeyGen-path
// `app/api/start-sandbox-session/route.ts` but returns a LiveKit access
// token instead of a HeyGen session token. The request body is expected to
// contain a `ContextInput` (the same shape `lib/avatar-context-builder.ts`
// consumes on the HeyGen side — see `agent/system-prompt.ts` for the
// duplicated type definition used by the LiveKit agent). The ContextInput is
// serialized as JSON and attached to the token's ROOM metadata via
// `AccessToken.roomConfig`, so when the room is auto-created on join the
// agent can read `ctx.room.metadata` and build a dynamic persona prompt for
// this specific guest.
//
// The HeyGen route returns `{ session_token, session_id, context_id }`. The
// LiveKit route returns `{ token, roomName, participantName, serverUrl }` —
// the shape is intentionally different. `app/home-v2/page.tsx` (Stage 5) will
// adapt to this shape.
//
// Graceful degradation:
//   - If the request body is missing, invalid JSON, or lacks a
//     `identity.firstName`, the route STILL mints a token — without room
//     metadata — and the agent degrades to its PLACEHOLDER_PROMPT. This lets
//     legacy callers (the throwaway /livekit-test direct-token path) keep
//     working unchanged, and it means a malformed profile never results in
//     a user-facing crash.
//
// ---------------------------------------------------------------------------

type ContextInputIdentity = {
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  [key: string]: unknown;
};

type ContextInputBody = {
  identity?: ContextInputIdentity;
  personality?: unknown;
  preferences?: unknown;
  loyalty?: unknown;
  [key: string]: unknown;
};

function sanitizeForIdentity(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "guest";
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_URL ?? process.env.NEXT_PUBLIC_LIVEKIT_URL;

  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: "LiveKit API credentials not configured" },
      { status: 500 },
    );
  }

  // Parse optional ContextInput body. A completely missing or malformed body
  // is NOT an error — we fall through to the placeholder-prompt path.
  let contextInput: ContextInputBody | null = null;
  try {
    const rawBody = (await req.json().catch(() => null)) as unknown;
    if (rawBody && typeof rawBody === "object") {
      const candidate = rawBody as ContextInputBody;
      if (
        candidate.identity &&
        typeof candidate.identity === "object" &&
        typeof candidate.identity.firstName === "string" &&
        candidate.identity.firstName.length > 0
      ) {
        contextInput = candidate;
      } else {
        console.warn(
          "[start-livekit-session] body present but missing identity.firstName — falling back to placeholder prompt",
        );
      }
    }
  } catch (err) {
    console.warn("[start-livekit-session] failed to parse body:", err);
  }

  // Derive room + participant identifiers.
  const roomName = `omnam-${crypto.randomUUID()}`;

  const rawFirstName =
    contextInput?.identity?.firstName && typeof contextInput.identity.firstName === "string"
      ? contextInput.identity.firstName
      : null;
  const rawEmail =
    contextInput?.identity?.email && typeof contextInput.identity.email === "string"
      ? contextInput.identity.email
      : null;

  const participantNameSuffix =
    rawEmail ?? rawFirstName ?? crypto.randomBytes(4).toString("hex");
  const participantName = `user-${sanitizeForIdentity(participantNameSuffix)}`;

  // Mint token.
  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantName,
    name: rawFirstName ?? undefined,
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  // Attach ContextInput as ROOM metadata via roomConfig. The note on the
  // LiveKit server SDK's AccessToken is that `token.metadata = ...` sets
  // PARTICIPANT metadata, whereas `token.roomConfig = new RoomConfiguration({
  // name, metadata })` sets ROOM metadata applied to the room the moment the
  // token is used to auto-create it. The agent reads room metadata via
  // `ctx.room.metadata` on connect (verified in
  // `node_modules/@livekit/rtc-node/dist/room.d.ts:60`).
  if (contextInput) {
    try {
      token.roomConfig = new RoomConfiguration({
        name: roomName,
        metadata: JSON.stringify(contextInput),
      });
    } catch (err) {
      console.warn(
        "[start-livekit-session] failed to attach room metadata — falling back to placeholder prompt:",
        err,
      );
    }
  }

  const jwt = await token.toJwt();

  return NextResponse.json({
    token: jwt,
    roomName,
    participantName,
    serverUrl: serverUrl ?? null,
  });
}
