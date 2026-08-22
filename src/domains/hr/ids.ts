export function sameUserId(a: string, b: string): boolean {
  return (
    a.replace(/-/g, "").toLowerCase().trim() ===
    b.replace(/-/g, "").toLowerCase().trim()
  )
}

export function asCalendarDay(value: string | null | undefined): string {
  return (value || "").trim().slice(0, 10)
}
