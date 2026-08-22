export function hasCashRegisterKey(
  keys: readonly string[],
  action: "read" | "create" | "update" | "delete",
  isOwner: boolean,
): boolean {
  if (isOwner) return true
  return keys.includes(`cash_registers:${action}`)
}

export function hasFullCashRegisterPermissions(
  keys: readonly string[],
  isOwner: boolean,
): boolean {
  return (
    hasCashRegisterKey(keys, "read", isOwner) &&
    hasCashRegisterKey(keys, "create", isOwner) &&
    hasCashRegisterKey(keys, "update", isOwner) &&
    hasCashRegisterKey(keys, "delete", isOwner)
  )
}

export function canCloseCashRegisterSession(input: {
  currentUserId: string
  openedByUserId: string | null
  keys: readonly string[]
  isOwner: boolean
}): boolean {
  if (!hasCashRegisterKey(input.keys, "update", input.isOwner)) return false
  if (
    input.openedByUserId != null &&
    input.openedByUserId === input.currentUserId
  ) {
    return true
  }
  return hasFullCashRegisterPermissions(input.keys, input.isOwner)
}
