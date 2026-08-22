const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseInventoryExpiresAt(raw: unknown): string | null {
  if (raw == null) return null
  const iso = String(raw).trim().slice(0, 10)
  if (!iso) return null
  const match = ISO_DATE.exec(iso)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return iso
}

export function applyInventoryFefoOrder<
  T extends {
    order: (
      column: string,
      options?: { ascending?: boolean; nullsFirst?: boolean },
    ) => T
  },
>(query: T): T {
  return query
    .order("expires_at", { ascending: true, nullsFirst: false })
    .order("received_at", { ascending: true })
}

export function calendarDaysUntilExpiry(
  expiresAt: string,
  todayIso: string,
): number | null {
  const expires = parseIsoDateLocal(expiresAt)
  const today = parseIsoDateLocal(todayIso)
  if (!expires || !today) return null
  return Math.round((expires.getTime() - today.getTime()) / 86_400_000)
}

function parseIsoDateLocal(iso: string): Date | null {
  const match = ISO_DATE.exec(iso.trim().slice(0, 10))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return date
}

export type InventoryExpiryAlert = "expired" | "d7" | "d15" | "d30"

export function inventoryExpiryAlert(
  expiresAt: string | null,
  todayIso: string,
): InventoryExpiryAlert | null {
  if (!expiresAt) return null
  const days = calendarDaysUntilExpiry(expiresAt, todayIso)
  if (days == null) return null
  if (days < 0) return "expired"
  if (days <= 7) return "d7"
  if (days <= 15) return "d15"
  if (days <= 30) return "d30"
  return null
}
