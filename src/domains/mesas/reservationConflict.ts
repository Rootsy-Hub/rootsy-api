import type { MesaReservation } from "./schema.js"

const ACTIVE = new Set(["pending", "confirmed"])

function reservationTableIds(reservation: MesaReservation): string[] {
  if (reservation.tableIds.length) return reservation.tableIds
  return reservation.tableId ? [reservation.tableId] : []
}

function floorWindow(
  arrivalAt: string,
  settings: { floorBufferMinutes: number; graceMinutes: number },
) {
  const arrival = new Date(arrivalAt)
  return {
    start: new Date(arrival.getTime() - settings.floorBufferMinutes * 60_000),
    end: new Date(arrival.getTime() + settings.graceMinutes * 60_000),
  }
}

function overlap(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime()
}

export function findReservationTableConflict(input: {
  tableIds: string[]
  arrivalAt: string
  settings: { floorBufferMinutes: number; graceMinutes: number }
  reservations: MesaReservation[]
  excludeReservationId?: string | null
}): MesaReservation | null {
  const wanted = new Set(input.tableIds.filter(Boolean))
  if (wanted.size === 0) return null
  const draft = floorWindow(input.arrivalAt, input.settings)
  const conflicts = input.reservations
    .filter((reservation) => {
      if (
        input.excludeReservationId &&
        reservation.id === input.excludeReservationId
      ) {
        return false
      }
      if (!ACTIVE.has(reservation.status)) return false
      const shared = reservationTableIds(reservation).filter((id) =>
        wanted.has(id),
      )
      if (shared.length === 0) return false
      return overlap(draft, floorWindow(reservation.arrivalAt, input.settings))
    })
    .sort(
      (a, b) =>
        new Date(a.arrivalAt).getTime() - new Date(b.arrivalAt).getTime(),
    )
  return conflicts[0] ?? null
}
