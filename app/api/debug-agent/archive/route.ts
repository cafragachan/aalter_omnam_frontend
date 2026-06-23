import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { NextResponse } from "next/server"
import { z } from "zod"
import { toDebugJsonValue } from "@/lib/debug-agent/serialize"

const ArchiveSchema = z.object({
  runId: z.string().min(1).max(160),
  scenarioId: z.string().min(1).max(120).optional(),
  sessionId: z.string().min(1).max(160).optional(),
  kind: z.enum(["manual", "synthetic"]),
  payload: z.unknown(),
})

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const parsed = ArchiveSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request", details: parsed.error.flatten() }, { status: 400 })
  }

  const { runId, scenarioId, sessionId, kind, payload } = parsed.data
  const dir = path.join(process.cwd(), "debug-conversations", safeName(runId))
  const stableName = kind === "synthetic"
    ? scenarioId ?? sessionId ?? "synthetic"
    : sessionId ?? scenarioId ?? "manual"
  const filename = `${safeName(`${kind}__${stableName}`)}.json`
  const filePath = path.join(dir, filename)

  await mkdir(dir, { recursive: true })
  await writeFile(
    filePath,
    JSON.stringify(toDebugJsonValue({ archivedAt: new Date().toISOString(), runId, scenarioId, sessionId, kind, payload }), null, 2),
    "utf8",
  )

  return NextResponse.json({ ok: true, path: filePath })
}
