import * as dotenv from "dotenv";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

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

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error("missing LiveKit env"); process.exit(1);
}
if (!HEDRA_API_KEY || !HEDRA_AVATAR_ID) {
  console.error("missing Hedra env"); process.exit(1);
}

async function main() {
const roomName = `probe-${Date.now()}`;
console.log(`[probe] room: ${roomName}`);

// 1. Build a real LiveKit token for hedra-avatar-agent, same way the plugin does
const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
  identity: "hedra-avatar-agent",
  name: "hedra-avatar-agent",
});
(at as any).kind = "agent";
at.addGrant({ roomJoin: true, room: roomName });
(at as any).attributes = { "lk.publish_on_behalf": "probe-user" };
const livekitToken = await at.toJwt();
console.log(`[probe] generated livekit token (len=${livekitToken.length})`);

// 2. Call Hedra
const form = new FormData();
form.append("livekit_url", LIVEKIT_URL);
form.append("livekit_token", livekitToken);
form.append("avatar_id", HEDRA_AVATAR_ID);

const t0 = Date.now();
const res = await fetch("https://api.hedra.com/public/livekit/v1/session", {
  method: "POST",
  headers: { "x-api-key": HEDRA_API_KEY },
  body: form,
});
const body = await res.text();
console.log(`[probe] Hedra POST → ${res.status} in ${Date.now()-t0}ms`);
console.log(`[probe] headers: ${JSON.stringify([...res.headers.entries()])}`);
console.log(`[probe] body: ${body}`);

// 3. Poll LiveKit for the room every 3s for 30s
const svc = new RoomServiceClient(
  LIVEKIT_URL.replace(/^wss?:/, "https:"),
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
);

console.log(`[probe] polling LiveKit for room '${roomName}' every 3s, 30s total...`);
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const rooms = await svc.listRooms([roomName]);
    if (rooms.length === 0) {
      console.log(`[probe] t+${(i+1)*3}s: room not created — Hedra worker has NOT connected yet`);
      continue;
    }
    const participants = await svc.listParticipants(roomName);
    const names = participants.map((p) => `${p.identity}(${p.name||"—"})`).join(", ") || "<empty>";
    console.log(`[probe] t+${(i+1)*3}s: room exists, numParticipants=${rooms[0].numParticipants}, participants=[${names}]`);
    if (participants.some((p) => p.identity === "hedra-avatar-agent")) {
      console.log(`[probe] ✅ Hedra avatar joined! success.`);
      break;
    }
  } catch (err) {
    console.log(`[probe] t+${(i+1)*3}s: listRooms/listParticipants error: ${err}`);
  }
}

// Cleanup: try to delete the test room
try {
  await svc.deleteRoom(roomName);
  console.log(`[probe] cleaned up room ${roomName}`);
} catch {}
}
main().catch((e) => { console.error(e); process.exit(1); });
