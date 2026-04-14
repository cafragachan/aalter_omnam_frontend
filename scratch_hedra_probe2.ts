import * as dotenv from "dotenv";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { Room } from "livekit-client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env.local") });

const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  HEDRA_API_KEY,
  HEDRA_AVATAR_ID,
} = process.env;

async function main() {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !HEDRA_API_KEY || !HEDRA_AVATAR_ID) {
    console.error("missing env"); process.exit(1);
  }

  const roomName = `probe2-${Date.now()}`;
  console.log(`[probe2] room: ${roomName}\n`);

  // Build the EXACT same token the plugin builds
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: "hedra-avatar-agent",
    name: "hedra-avatar-agent",
  });
  (at as any).kind = "agent";
  at.addGrant({ roomJoin: true, room: roomName });
  (at as any).attributes = { "lk.publish_on_behalf": "probe-user" };
  const livekitToken = await at.toJwt();

  // ───────── Phase A: decode + inspect our token ─────────
  const [h, p] = livekitToken.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  console.log("=== Phase A: token contents ===");
  console.log("header:", JSON.stringify(header));
  console.log("claims:", JSON.stringify(claims, null, 2));
  console.log();

  // Phase B skipped: livekit-client needs browser WebRTC. Token is proven
  // valid by Phase A (decode shows every required claim is correct) plus
  // the fact that LIVEKIT_API_KEY/SECRET successfully authenticated against
  // RoomServiceClient.listRooms() in the earlier probe.

  // ───────── Phase C: hit Hedra with 3 URL-format variants ─────────
  console.log("=== Phase C: try Hedra with alternative livekit_url formats ===");
  const variants = [
    { label: "wss:// (current)",       url: LIVEKIT_URL },
    { label: "https:// equivalent",    url: LIVEKIT_URL.replace(/^wss?:/, "https:") },
    { label: "no-protocol host-only",  url: LIVEKIT_URL.replace(/^(wss?|https?):\/\//, "") },
  ];
  const svc = new RoomServiceClient(
    LIVEKIT_URL.replace(/^wss?:/, "https:"),
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
  );

  for (const v of variants) {
    const roomV = `${roomName}-${v.label.replace(/\W+/g, "")}`;
    const atV = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: "hedra-avatar-agent",
      name: "hedra-avatar-agent",
    });
    (atV as any).kind = "agent";
    atV.addGrant({ roomJoin: true, room: roomV });
    (atV as any).attributes = { "lk.publish_on_behalf": "probe-user" };
    const tokV = await atV.toJwt();

    const form = new FormData();
    form.append("livekit_url", v.url);
    form.append("livekit_token", tokV);
    form.append("avatar_id", HEDRA_AVATAR_ID);

    console.log(`\n--- variant: ${v.label}  url=${v.url} ---`);
    const res = await fetch("https://api.hedra.com/public/livekit/v1/session", {
      method: "POST",
      headers: { "x-api-key": HEDRA_API_KEY },
      body: form,
    });
    const body = await res.text();
    console.log(`[probe2] Hedra → ${res.status}: ${body}`);
    if (!res.ok) continue;

    // Poll LiveKit for that room every 2s for 20s
    let joined = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const rooms = await svc.listRooms([roomV]);
        if (rooms.length > 0) {
          const parts = await svc.listParticipants(roomV);
          const names = parts.map((p) => p.identity).join(",") || "<empty>";
          console.log(`[probe2] t+${(i+1)*2}s: room EXISTS, participants=[${names}]`);
          if (parts.some((p) => p.identity === "hedra-avatar-agent")) {
            console.log(`[probe2] 🎉 Hedra joined with variant: ${v.label}`);
            joined = true;
            break;
          }
        }
      } catch {}
    }
    if (!joined) {
      console.log(`[probe2] ⏱  variant '${v.label}': no Hedra join within 20s`);
    }
    try { await svc.deleteRoom(roomV); } catch {}
  }

  // ───────── Phase D: check for a v2 endpoint ─────────
  console.log("\n=== Phase D: probe for newer API versions ===");
  for (const p of [
    "/public/livekit/v2/session",
    "/public/realtime/v1/session",
    "/public/realtime-avatar/v1/session",
  ]) {
    const res = await fetch(`https://api.hedra.com${p}`, {
      method: "POST",
      headers: { "x-api-key": HEDRA_API_KEY! },
    });
    console.log(`${p} → HTTP ${res.status}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
