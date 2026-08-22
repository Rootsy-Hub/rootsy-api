import { z } from "zod"

export const CALENDAR_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export const upsertEmployeeBodySchema = z.object({
  id: z.string().uuid().optional(),
  firstName: z.string(),
  lastName: z.string(),
  jobTitle: z.string(),
  documentNumber: z.string(),
  email: z.string(),
  phone: z.string(),
  monthlySalary: z.string(),
  hiredAt: z.string(),
  notes: z.string(),
})

export const DAY_MARK_KINDS = ["franco", "falta"] as const

export const francoBodySchema = z.object({
  day: z.string(),
  kind: z.enum(DAY_MARK_KINDS).default("franco"),
})

export const EMPLOYEE_PAYMENT_KINDS = [
  "cash",
  "card_debit",
  "card_credit",
  "transfer",
  "other",
] as const

export const recordEmployeePaymentBodySchema = z.object({
  amount: z.number(),
  paidAt: z.string().regex(CALENDAR_DAY_RE),
  paymentKind: z.enum(EMPLOYEE_PAYMENT_KINDS),
  treasuryAccountId: z.string().uuid(),
  notes: z.string().optional().nullable(),
})

export type RecordEmployeePaymentBody = z.infer<
  typeof recordEmployeePaymentBodySchema
>

export const inviteBodySchema = z.object({
  employeeId: z.string().uuid(),
  roleId: z.string().uuid(),
  message: z.string().optional().nullable(),
  inviteBaseUrl: z.string().url().optional(),
})

export const memberRoleBodySchema = z.object({
  roleId: z.string().uuid(),
})

export const roleGrantsBodySchema = z.object({
  grantKeys: z.array(z.string()),
})

export const createRoleBodySchema = z.object({
  displayName: z.string(),
  grantKeys: z.array(z.string()),
})

export type UpsertEmployeeBody = z.infer<typeof upsertEmployeeBodySchema>

export type EmployeeRow = {
  id: string
  userId: string | null
  firstName: string
  lastName: string
  jobTitle: string | null
  documentNumber: string | null
  email: string | null
  phone: string | null
  monthlySalary: number | null
  hiredAt: string | null
  leftAt: string | null
  notes: string | null
  isClockedIn: boolean
  clockedInAt: string | null
}

export type AttendancePunchRow = {
  id: string
  clockedInAt: string
  clockedOutAt: string | null
}

export type DayMarkKind = (typeof DAY_MARK_KINDS)[number]

export type FrancoRow = {
  id: string
  day: string
  kind: DayMarkKind
}

export type EmployeePaymentRow = {
  id: string
  amount: number
  paidAt: string
  paymentKind: string
  treasuryAccountId: string
  treasuryAccountName: string | null
  notes: string | null
}

export type PopRoleRow = {
  id: string
  name: string
  displayName: string
  description: string | null
  isSystem: boolean
  popId: string | null
}

export type MemberRow = {
  userId: string
  roleId: string
  roleDisplayName: string
  roleName: string
  firstName: string
  lastName: string
  imageUrl: string | null
  invitedAt: string | null
  isOwner: boolean
  isActive: boolean
}

export type PendingInviteRow = {
  id: string
  email: string
  employeeId: string | null
  roleId: string
  roleDisplayName: string
  message: string | null
  createdAt: string
  expiresAt: string
  inviteUrl: string
}

export type HrDashboardData = {
  popName: string
  isOwner: boolean
  canManageInvites: boolean
  canManagePeople: boolean
  permissionKeys: string[]
  roles: PopRoleRow[]
  members: MemberRow[]
  employees: EmployeeRow[]
  pendingInvites: PendingInviteRow[]
}

export type EmployeeDetailData = {
  employee: EmployeeRow
  punches: AttendancePunchRow[]
  francos: FrancoRow[]
  payments: EmployeePaymentRow[]
  imageUrl: string | null
  canManagePeople: boolean
}

export function parseSalaryInput(raw: string): number | null | "invalid" {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let n: number
  if (trimmed.includes(",")) {
    n = Number.parseFloat(trimmed.replace(/\./g, "").replace(",", "."))
  } else {
    const digits = trimmed.replace(/\./g, "").replace(/[^\d.-]/g, "")
    n = Number.parseFloat(digits)
  }
  if (!Number.isFinite(n) || n < 0) return "invalid"
  return Math.round(n * 100) / 100
}

export function mapRoleRpcError(code: string | undefined): string {
  const m: Record<string, string> = {
    not_authenticated: "Tenés que iniciar sesión.",
    forbidden: "Solo el dueño del punto de venta puede gestionar roles.",
    not_found: "Rol no encontrado.",
    invalid_role:
      "Solo se pueden editar o eliminar roles propios de este punto de venta (no roles de sistema).",
    cannot_delete_owner: "No se puede eliminar el rol de propietario.",
    role_in_use:
      "No se puede eliminar: hay miembros activos con este rol en el POP. Reasignalos o desvinculalos primero.",
    invalid_permission: "Algún permiso enviado no es válido.",
    invalid_display_name: "El nombre del rol es obligatorio.",
  }
  return m[code || ""] || "No se pudo completar la operación."
}
