import * as dotenv from "dotenv";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AccessToken } from "livekit-server-sdk";
import { Room, RoomEvent } from "@livekit/rtc-node";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env.local") });

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

async function tryConnect(label: string, tokenBuilder: (room: string) => Promise<string>) {
  const roomName = `lktest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  console.log(`\n─── ${label} ───  room=${roomName}`);
  const token = await tokenBuilder(roomName);
  const room = new Room();
  let gotConnected = false;
  let gotDisconnected = false;
  let disconnectReason: unknown = null;
  room.on(RoomEvent.Connected, () => {
    gotConnected = true;
    console.log(`  ✅ RoomEvent.Connected fired — LiveKit accepted the token`);
  });
  room.on(RoomEvent.Disconnected, (reason) => {
    gotDisconnected = true;
    disconnectReason = reason;
    console.log(`  ⚠️  RoomEvent.Disconnected: ${JSON.stringify(reason)}`);
  });
  try {
    await room.connect(LIVEKIT_URL!, token, { autoSubscribe: true, dynacast: false });
    console.log(`  room.connect() returned successfully`);
    // Stay connected briefly to see if LiveKit kicks us
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`  after 3s: localParticipant.identity='${room.localParticipant?.identity}' sid='${room.localParticipant?.sid}'`);
    await room.disconnect();
  } catch (err) {
    console.log(`  ❌ room.connect() threw: ${err}`);
  }
  console.log(`  → summary: connected=${gotConnected} disconnected=${gotDisconnected} reason=${JSON.stringify(disconnectReason)}`);
}

async function main() {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    console.error("missing LiveKit env"); process.exit(1);
  }

  console.log("Testing LiveKit connection acceptance for the same token shape Hedra would use.\n");

  // Variant 1: exact replica of Hedra plugin's token
  await tryConnect("Variant 1 — Hedra-plugin-shaped token (kind=agent, publish_on_behalf)", async (roomName) => {
    const at = new AccessToken(LIVEKIT_API_KEY!, LIVEKIT_API_SECRET!, {
      identity: "hedra-avatar-agent",
      name: "hedra-avatar-agent",
    });
    (at as any).kind = "agent";
    at.addGrant({ roomJoin: true, room: roomName });
    (at as any).attributes = { "lk.publish_on_behalf": "probe-user" };
    return at.toJwt();
  });

  // Variant 2: same but WITHOUT kind=agent (tests if "agent" type triggers a quota)
  await tryConnect("Variant 2 — same token, NO kind=agent (plain participant)", async (roomName) => {
    const at = new AccessToken(LIVEKIT_API_KEY!, LIVEKIT_API_SECRET!, {
      identity: "hedra-avatar-agent-plain",
      name: "hedra-avatar-agent-plain",
    });
    at.addGrant({ roomJoin: true, room: roomName });
    return at.toJwt();
  });

  // Variant 3: minimal — just roomJoin, plain identity
  await tryConnect("Variant 3 — minimal plain participant (sanity baseline)", async (roomName) => {
    const at = new AccessToken(LIVEKIT_API_KEY!, LIVEKIT_API_SECRET!, {
      identity: `probe-user-${Math.random().toString(36).slice(2, 8)}`,
    });
    at.addGrant({ roomJoin: true, room: roomName });
    return at.toJwt();
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
