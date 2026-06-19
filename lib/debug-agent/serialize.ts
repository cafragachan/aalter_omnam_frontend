export function toDebugJsonValue(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => toDebugJsonValue(item))
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toDebugJsonValue(item)
    }
    return out
  }
  return value
}

export function toDebugRecord<T>(value: T): T {
  return toDebugJsonValue(value) as T
}

