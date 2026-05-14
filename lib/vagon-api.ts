/**
 * Vagon Streams API — HMAC-authenticated machine lifecycle management.
 *
 * Flow: getStreams → startMachine → assignMachine → stopMachine.
 */

import crypto from "crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MachineAttributes {
  start_at: string
  end_at: string
  status: string
  friendly_status: string
  connection_status: string
  region: string
  uid: string
  cost: string
  duration: number
  application_name: string
  application_id: number
  stream_id: number
  stream_name: string
  machine_type: string
  public_ip_address: string | null
}

export interface Machine {
  id: string
  type: string
  attributes: MachineAttributes
}

export interface Stream {
  id: string
  [key: string]: unknown
}

interface StreamsResponse {
  streams: Stream[]
}

interface AssignMachineResponse {
  connection_link: string
  machine: Machine
  client_code: number
  message: string | null
  timestamp: string
}

export interface AssignResult {
  connectionLink: string
  machineId: string
}

// ---------------------------------------------------------------------------
// Config — read lazily so serverless env vars are always fresh
// ---------------------------------------------------------------------------

const API_BASE = "https://api.vagon.io"

function getConfig() {
  return {
    apiKey: process.env.NEXT_PUBLIC_VAGON_API_KEY ?? "",
    apiSecret: process.env.NEXT_PUBLIC_VAGON_API_SECRET ?? "",
    appId: process.env.NEXT_PUBLIC_VAGON_APP_ID ?? "",
    region: process.env.NEXT_PUBLIC_VAGON_REGION ?? "dublin",
  }
}

// ---------------------------------------------------------------------------
// HMAC signer
// ---------------------------------------------------------------------------

function generateHMAC(method: string, path: string, body = ""): string {
  const { apiKey, apiSecret } = getConfig()
  const nonce = crypto.randomBytes(16).toString("hex")
  const timestamp = Date.now().toString()
  const payload = `${apiKey}${method}${path}${timestamp}${nonce}${body}`
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(payload)
    .digest("hex")
  return `HMAC ${apiKey}:${signature}:${nonce}:${timestamp}`
}

function authedHeaders(method: string, path: string, body = "") {
  return {
    "Content-Type": "application/json",
    Authorization: generateHMAC(method, path, body),
  }
}

/** Fetch available streams for our app. */
export async function getStreams(): Promise<string> {
  const { appId } = getConfig()
  const path = "/app-stream-management/v2/streams"
  const res = await fetch(`${API_BASE}${path}?application_id=${appId}`, {
    method: "GET",
    headers: authedHeaders("GET", path),
  })
  if (!res.ok) throw new Error(`getStreams failed: ${res.status}`)
  const data: StreamsResponse = await res.json()
  if (!Array.isArray(data.streams) || data.streams.length === 0) {
    throw new Error("No streams available")
  }
  return data.streams[0].id
}

/** Start a machine for the given stream. */
export async function startMachine(streamId: string): Promise<void> {
  const { region } = getConfig()
  const path = `/app-stream-management/v2/streams/${streamId}/start-machine`
  const body = JSON.stringify({ region })
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authedHeaders("POST", path, body),
    body,
  })
  if (!res.ok) throw new Error(`startMachine failed: ${res.status}`)
}

/** Assign a machine and return the connection link + machine ID. */
export async function assignMachine(streamId: string): Promise<AssignResult> {
  const { region } = getConfig()
  const path = `/app-stream-management/v2/streams/${streamId}/assign-machine`
  const body = JSON.stringify({ region })
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authedHeaders("POST", path, body),
    body,
  })
  if (!res.ok) throw new Error(`assignMachine failed: ${res.status}`)
  const data: AssignMachineResponse = await res.json()
  return {
    connectionLink: data.connection_link,
    machineId: data.machine.id,
  }
}

/** Stop a machine by ID. */
export async function stopMachine(machineId: string): Promise<void> {
  const path = "/app-stream-management/v2/streams/stop-machine"
  const body = JSON.stringify({ machine_id: machineId })
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authedHeaders("POST", path, body),
    body,
  })
  if (!res.ok) {
    console.error(`stopMachine failed: ${res.status}`)
  }
}
