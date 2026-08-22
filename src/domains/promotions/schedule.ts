import { ALL_PROMOTION_WEEKDAYS } from "./types.js"

export type PromotionScheduleInput = {
  validFrom: string | null
  validUntil: string | null
  validTimeStart: string | null
  validTimeEnd: string | null
  scheduleDays: number[]
}

function parseDateOnly(v: string | null | undefined): Date | null {
  const t = v?.trim()
  if (!t) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return null
  return d
}

function parseTimeToMinutes(v: string | null | undefined): number | null {
  const t = v?.trim()
  if (!t) return null
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

export function normalizeScheduleDays(days: number[] | null | undefined): number[] {
  if (!days?.length) return [...ALL_PROMOTION_WEEKDAYS]
  const set = new Set<number>()
  for (const d of days) {
    if (Number.isInteger(d) && d >= 0 && d <= 6) set.add(d)
  }
  if (set.size === 0) return [...ALL_PROMOTION_WEEKDAYS]
  return [...set].sort((a, b) => a - b)
}

export function validatePromotionSchedule(
  input: PromotionScheduleInput,
): { ok: true } | { ok: false; error: string } {
  const from = parseDateOnly(input.validFrom)
  const until = parseDateOnly(input.validUntil)
  if (input.validFrom?.trim() && !from) {
    return { ok: false, error: "Fecha de inicio inválida." }
  }
  if (input.validUntil?.trim() && !until) {
    return { ok: false, error: "Fecha de fin inválida." }
  }
  if (from && until && from > until) {
    return { ok: false, error: "La fecha de fin no puede ser anterior al inicio." }
  }

  const startMin = parseTimeToMinutes(input.validTimeStart)
  const endMin = parseTimeToMinutes(input.validTimeEnd)
  if (input.validTimeStart?.trim() && startMin == null) {
    return { ok: false, error: "Hora de inicio inválida." }
  }
  if (input.validTimeEnd?.trim() && endMin == null) {
    return { ok: false, error: "Hora de fin inválida." }
  }
  const hasStart = startMin != null
  const hasEnd = endMin != null
  if (hasStart !== hasEnd) {
    return {
      ok: false,
      error: "Indicá hora de inicio y fin, o dejá ambas vacías.",
    }
  }
  if (hasStart && hasEnd && startMin! >= endMin!) {
    return {
      ok: false,
      error: "La hora de fin debe ser posterior a la de inicio.",
    }
  }

  const days = normalizeScheduleDays(input.scheduleDays)
  if (days.length === 0) {
    return { ok: false, error: "Seleccioná al menos un día de la semana." }
  }
  return { ok: true }
}

export function scheduleDaysFromDb(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...ALL_PROMOTION_WEEKDAYS]
  return normalizeScheduleDays(raw.map((v) => Number(v)))
}

export function scheduleTimeFromDb(raw: unknown): string | null {
  if (raw == null) return null
  const t = String(raw).trim()
  if (!t) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  if (!m) return null
  return `${m[1].padStart(2, "0")}:${m[2]}`
}

export function scheduleDateFromDb(raw: unknown): string | null {
  if (raw == null) return null
  const t = String(raw).trim()
  if (!t) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t)
  return m ? m[1] : null
}
