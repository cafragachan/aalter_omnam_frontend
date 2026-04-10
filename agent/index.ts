import { voice, defineAgent, cli, ServerOptions } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as hedra from "@livekit/agents-plugin-hedra";
import { JobContext } from "@livekit/agents";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

// Load .env.local from project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: "gpt-4o-realtime-preview",
        voice: "sage",
        turnDetection: {
          type: "semantic_vad",
          eagerness: "high",
        },
        inputAudioTranscription: { model: "gpt-4o-mini-transcribe" },
      }),
    });

    const avatar = new hedra.AvatarSession({
      avatarId: process.env.HEDRA_AVATAR_ID,
    });

    // Start the avatar and wait for it to join the room
    await avatar.start(session, ctx.room);

    // Start the agent session
    // Disable RoomIO audio output so Hedra's DataStreamAudioOutput stays in place
    // (dropping this breaks lip-sync)
    await session.start({
      agent: new voice.Agent({
        instructions:
          "You are Ava, the Omnam concierge. You help guests book luxury hotel experiences. Always respond in English.",
      }),
      room: ctx.room,
      outputOptions: { audioEnabled: false },
    });

    // Proactively greet the user
    await session.generateReply();
  },
});

cli.runApp(new ServerOptions({ agent: __filename }));
