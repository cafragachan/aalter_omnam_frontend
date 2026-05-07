import { z } from "zod"
import { LAKE_COMO_OSM_ANCHOR } from "@/lib/hotels/lake-como"

// ---------------------------------------------------------------------------
// /api/locate-interest-points — POI discovery for the UE5 OSM scene.
//
// Pipeline:
//   1. LLM proposes named places near the anchor (NO coordinates — coords
//      from the LLM hallucinate frequently and have landed markers in the
//      middle of Lake Como during prior tests).
//   2. Each proposal is verified via Google Places API (New) Text Search.
//      The Places result supplies the authoritative lat/lng + place_id.
//   3. Distance is computed via haversine from the anchor; navigation times
//      are heuristic strings (the Routes API would be N extra calls per
//      query — defer until product wants real ETAs).
//   4. Results are sorted by distance, capped at `maxResults` (default 10,
//      hard max 20 per the UE5 brief).
//
// Output shape matches AOSMInterestPointsManager.Initialise expectations:
//   { name, description, latitude, longitude, distance, navigation, url }
// Field names are lowercase and must not be renamed.
// ---------------------------------------------------------------------------

const RequestSchema = z.object({
  category: z.string().min(1).max(120),
  // Optional override; defaults to the Lake Como Cesium origin so callers
  // (today only the journey executor) don't have to know about anchors.
  anchor: z
    .object({ lat: z.number(), lng: z.number() })
    .optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
})

type Anchor = { lat: number; lng: number }

type LLMCandidate = {
  name: string
  address_hint: string
  description: string
  url?: string
}

type PointOfInterest = {
  name: string
  description: string
  latitude: number
  longitude: number
  distance: number
  navigation: { car: string; transport: string; walking: string }
  url: string
}

// --- Haversine distance (km) -----------------------------------------------
function haversineKm(a: Anchor, b: Anchor): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const R = 6371
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// --- Heuristic travel-time strings -----------------------------------------
// UE5 only displays these — no parsing — so rough estimates are fine.
function estimateNavigation(distanceKm: number): { car: string; transport: string; walking: string } {
  const car = Math.max(1, Math.round((distanceKm / 0.6) + 1))
  const transport = Math.max(1, Math.round(distanceKm * 2 + 3))
  const walking = Math.max(1, Math.round(distanceKm * 12))
  return {
    car: `${car} min`,
    transport: `${transport} min`,
    walking: `${walking} min`,
  }
}

// --- LLM step: propose named places (no coordinates) -----------------------
async function proposeLLMCandidates(
  category: string,
  anchor: Anchor,
  maxCandidates: number,
  openaiKey: string,
): Promise<LLMCandidate[]> {
  const system = `You recommend real, currently-operating points of interest near a specific anchor location for a luxury travel concierge.

Return ONLY places you are highly confident exist today. Bias toward well-known, well-reviewed venues. Do NOT include latitude or longitude — those will be verified through a places API.

For each candidate include:
- name: the venue's exact name as it appears on Google Maps
- address_hint: "City, Country" or a short street address — enough for the Places API to disambiguate
- description: 1–2 sentences, warm but factual
- url: official site or Wikipedia URL when you are confident; "" otherwise

Return JSON of shape: { "candidates": [{ name, address_hint, description, url }] }`

  const user = `Anchor: latitude ${anchor.lat}, longitude ${anchor.lng} (Lake Como area, near Bellagio).
Category requested: ${category}
Return up to ${maxCandidates} candidates, sorted from closest to anchor outward.`

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`OpenAI proposal failed: ${res.status} ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }

  const list = (parsed as { candidates?: unknown }).candidates
  if (!Array.isArray(list)) return []

  return list.flatMap((c): LLMCandidate[] => {
    if (typeof c !== "object" || c === null) return []
    const obj = c as Record<string, unknown>
    if (typeof obj.name !== "string" || obj.name.trim().length === 0) return []
    return [{
      name: obj.name.trim(),
      address_hint: typeof obj.address_hint === "string" ? obj.address_hint.trim() : "",
      description: typeof obj.description === "string" ? obj.description.trim() : "",
      url: typeof obj.url === "string" ? obj.url.trim() : "",
    }]
  })
}

// --- Places API verification ------------------------------------------------
type PlacesMatch = {
  latitude: number
  longitude: number
  formattedAddress?: string
  websiteUri?: string
  displayName?: string
}

async function verifyWithPlaces(
  candidate: LLMCandidate,
  anchor: Anchor,
  apiKey: string,
): Promise<PlacesMatch | null> {
  const textQuery = candidate.address_hint
    ? `${candidate.name} ${candidate.address_hint}`
    : candidate.name

  const body = {
    textQuery,
    locationBias: {
      circle: {
        center: { latitude: anchor.lat, longitude: anchor.lng },
        radius: 50000,
      },
    },
    maxResultCount: 5,
  }

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.location,places.formattedAddress,places.websiteUri",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    console.warn("[POI] Places search failed", {
      status: res.status,
      query: textQuery,
      body: text.slice(0, 200),
    })
    return null
  }

  const data = (await res.json()) as {
    places?: Array<{
      id?: string
      displayName?: { text?: string }
      location?: { latitude?: number; longitude?: number }
      formattedAddress?: string
      websiteUri?: string
    }>
  }

  const places = data.places ?? []
  if (places.length === 0) return null

  // Prefer the result geographically nearest to the anchor — Places' default
  // ranking already uses locationBias, but multiple candidates with the same
  // textQuery occasionally collide (e.g. chain restaurants).
  let best: PlacesMatch | null = null
  let bestDist = Infinity
  for (const p of places) {
    const lat = p.location?.latitude
    const lng = p.location?.longitude
    if (typeof lat !== "number" || typeof lng !== "number") continue
    const d = haversineKm(anchor, { lat, lng })
    if (d < bestDist) {
      bestDist = d
      best = {
        latitude: lat,
        longitude: lng,
        formattedAddress: p.formattedAddress,
        websiteUri: p.websiteUri,
        displayName: p.displayName?.text,
      }
    }
  }
  return best
}

// --- Route handler ----------------------------------------------------------
export async function POST(request: Request) {
  const requestStart = Date.now()
  try {
    const body = await request.json()
    const parsed = RequestSchema.safeParse(body)
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "invalid request", details: parsed.error.flatten() }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const { category, anchor: anchorOverride, maxResults } = parsed.data
    const anchor: Anchor = anchorOverride ?? LAKE_COMO_OSM_ANCHOR
    const cap = maxResults ?? 10

    const openaiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
    const placesKey = process.env.GOOGLE_PLACES_API_KEY
    if (!openaiKey) {
      return new Response(
        JSON.stringify({ error: "OPENAI_API_KEY not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )
    }
    if (!placesKey) {
      return new Response(
        JSON.stringify({ error: "GOOGLE_PLACES_API_KEY not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )
    }

    // Over-fetch by ~50% so we still hit `cap` after Places drops unmatched.
    const proposalCap = Math.min(20, Math.ceil(cap * 1.5))
    const llmStart = Date.now()
    const candidates = await proposeLLMCandidates(category, anchor, proposalCap, openaiKey)
    const llmEnd = Date.now()

    // Verify each candidate in parallel; failures are silent.
    const placesStart = Date.now()
    const verified = await Promise.all(
      candidates.map(async (c) => {
        const match = await verifyWithPlaces(c, anchor, placesKey).catch((err) => {
          console.warn("[POI] verify threw", { name: c.name, err })
          return null
        })
        if (!match) return null
        const distance = Number(
          haversineKm(anchor, { lat: match.latitude, lng: match.longitude }).toFixed(1),
        )
        const point: PointOfInterest = {
          // Prefer the LLM's name (more colloquial) but fall back to Places'
          // displayName if the LLM left it blank.
          name: c.name || match.displayName || "Unknown",
          description: c.description || "",
          latitude: match.latitude,
          longitude: match.longitude,
          distance,
          navigation: estimateNavigation(distance),
          url: match.websiteUri || c.url || "",
        }
        return point
      }),
    )
    const placesEnd = Date.now()

    const points = verified
      .filter((p): p is PointOfInterest => p !== null)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, cap)

    const meta = {
      anchor,
      category,
      llmProposalCount: candidates.length,
      verifiedCount: points.length,
      durationMs: Date.now() - requestStart,
      llmMs: llmEnd - llmStart,
      placesMs: placesEnd - placesStart,
    }

    console.log("[POI]", JSON.stringify(meta))

    return new Response(JSON.stringify({ points, meta }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (err) {
    console.error("[POI] handler error", err)
    return new Response(
      JSON.stringify({ error: (err as Error).message ?? "internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
