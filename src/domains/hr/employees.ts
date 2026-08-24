import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import {
  auditedDelete,
  auditedInsert,
  auditedUpdate,
} from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import { hasAnyPermission } from "../../sidecar/permissions.js"
import {
  entryDateIsoInTimezone,
  timestampToLocalDateIso,
  timezoneForPopLedger,
} from "../operations/timezone.js"
import { asCalendarDay } from "./ids.js"
import { mergePatch } from "../../lib/patchBody.js"
import {
  CALENDAR_DAY_RE,
  CLOCK_PIN_RE,
  parseSalaryInput,
  type AttendancePunchRow,
  type ClockByPinData,
  type EmployeeDetailData,
  type EmployeePaymentRow,
  type EmployeeRow,
  type FrancoRow,
  type MemberRow,
  type PatchEmployeeBody,
  type UpsertEmployeeBody,
} from "./schema.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }

type EmployeeDbRow = {
  id: string
  user_id: string | null
  first_name: string
  last_name: string
  job_title: string | null
  document_number: string | null
  email: string | null
  phone: string | null
  monthly_salary: number | string | null
  hired_at: string | null
  left_at: string | null
  notes: string | null
  clock_pin?: string | null
}

const EMPLOYEE_SELECT =
  "id, user_id, first_name, last_name, job_title, document_number, email, phone, monthly_salary, hired_at, left_at, notes"

function mapEmployee(
  row: EmployeeDbRow,
  openByEmployee: Map<string, string>,
): EmployeeRow {
  const salary =
    row.monthly_salary == null || row.monthly_salary === ""
      ? null
      : Number(row.monthly_salary)
  return {
    id: String(row.id),
    userId: row.user_id ? String(row.user_id) : null,
    firstName: row.first_name,
    lastName: row.last_name,
    jobTitle: row.job_title,
    documentNumber: row.document_number,
    email: row.email,
    phone: row.phone,
    monthlySalary: Number.isFinite(salary) ? salary : null,
    hiredAt: row.hired_at,
    leftAt: row.left_at,
    notes: row.notes,
    isClockedIn: openByEmployee.has(row.id),
    clockedInAt: openByEmployee.get(row.id) ?? null,
    clockPin: null,
  }
}

const DETAIL_EMPLOYEE_SELECT = `${EMPLOYEE_SELECT}, clock_pin`

function randomClockPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000))
}

async function allocateClockPin(
  supabase: SupabaseClient,
  popId: string,
  reserved: Set<string> = new Set(),
  excludeEmployeeId?: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const pin = randomClockPin()
    if (reserved.has(pin)) continue
    let query = supabase
      .from("pop_employees")
      .select("id")
      .eq("pop_id", popId)
      .eq("clock_pin", pin)
      .is("left_at", null)
    if (excludeEmployeeId) query = query.neq("id", excludeEmployeeId)
    const { data } = await query.maybeSingle()
    if (!data) {
      reserved.add(pin)
      return pin
    }
  }
  return null
}

function isEmployeeStubName(firstName: string | null, lastName: string | null) {
  const first = (firstName || "").trim()
  const last = (lastName || "").trim()
  return !first || (first === "Sin" && !last)
}

async function loadPopTimeZone(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
): Promise<string> {
  const { data } = await supabase
    .from("pops")
    .select("country")
    .eq("id", popId)
    .maybeSingle()
  return timezoneForPopLedger(
    typeof data?.country === "string" ? data.country : null,
    popSiteId,
  )
}

export async function listEmployees(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; employees: EmployeeRow[] }
  | { success: false; error: string; status: 500 }
> {
  const { data: rows, error } = await supabase
    .from("pop_employees")
    .select(EMPLOYEE_SELECT)
    .eq("pop_id", popId)
    .order("last_name")
    .order("first_name")

  if (error) return { success: false, error: error.message, status: 500 }

  const { data: openRows } = await supabase
    .from("pop_employee_attendance")
    .select("employee_id, clocked_in_at")
    .eq("pop_id", popId)
    .is("clocked_out_at", null)

  const openByEmployee = new Map<string, string>()
  for (const punch of openRows || []) {
    openByEmployee.set(String(punch.employee_id), String(punch.clocked_in_at))
  }

  return {
    success: true,
    employees: ((rows || []) as EmployeeDbRow[]).map((row) =>
      mapEmployee(row, openByEmployee),
    ),
  }
}

export async function getEmployeeDetail(
  supabase: SupabaseClient,
  popId: string,
  employeeId: string,
  keys: readonly string[],
  isOwner: boolean,
): Promise<
  | { success: true; data: EmployeeDetailData }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data: row, error } = await supabase
    .from("pop_employees")
    .select(DETAIL_EMPLOYEE_SELECT)
    .eq("pop_id", popId)
    .eq("id", employeeId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!row) {
    return { success: false, error: "No encontramos a esa persona.", status: 404 }
  }

  const { data: punchRows, error: punchError } = await supabase
    .from("pop_employee_attendance")
    .select("id, clocked_in_at, clocked_out_at")
    .eq("pop_id", popId)
    .eq("employee_id", employeeId)
    .order("clocked_in_at", { ascending: false })
    .limit(500)

  if (punchError) {
    return { success: false, error: punchError.message, status: 500 }
  }

  const { data: francoRows, error: francoError } = await supabase
    .from("pop_employee_francos")
    .select("id, day, kind")
    .eq("pop_id", popId)
    .eq("employee_id", employeeId)
    .order("day", { ascending: false })
    .limit(500)

  if (francoError) {
    return { success: false, error: francoError.message, status: 500 }
  }

  const { data: paymentRows, error: paymentError } = await supabase
    .from("pop_employee_payments")
    .select(
      "id, amount, paid_at, payment_kind, treasury_account_id, notes, treasury_accounts ( name )",
    )
    .eq("pop_id", popId)
    .eq("employee_id", employeeId)
    .order("paid_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500)

  if (paymentError) {
    return { success: false, error: paymentError.message, status: 500 }
  }

  const punches: AttendancePunchRow[] = (punchRows || []).map((punch) => ({
    id: String(punch.id),
    clockedInAt: String(punch.clocked_in_at),
    clockedOutAt: punch.clocked_out_at != null ? String(punch.clocked_out_at) : null,
  }))
  const francos: FrancoRow[] = (francoRows || []).map((franco) => ({
    id: String(franco.id),
    day: asCalendarDay(String(franco.day ?? "")),
    kind: franco.kind === "falta" ? "falta" : "franco",
  }))
  const payments: EmployeePaymentRow[] = (paymentRows || []).map((payment) => {
    const account = payment.treasury_accounts as unknown as
      | { name?: string | null }
      | { name?: string | null }[]
      | null
    const accountRow = Array.isArray(account) ? account[0] : account
    const amount = Number(payment.amount)
    return {
      id: String(payment.id),
      amount: Number.isFinite(amount) ? amount : 0,
      paidAt: asCalendarDay(String(payment.paid_at ?? "")),
      paymentKind: String(payment.payment_kind ?? ""),
      treasuryAccountId: String(payment.treasury_account_id ?? ""),
      treasuryAccountName: accountRow?.name ? String(accountRow.name) : null,
      notes: payment.notes != null ? String(payment.notes) : null,
    }
  })
  const openPunch = punches.find((punch) => punch.clockedOutAt == null)
  const openByEmployee = new Map<string, string>()
  if (openPunch) openByEmployee.set(String(row.id), openPunch.clockedInAt)
  const canManagePeople =
    isOwner || hasAnyPermission(keys, ["hr:create", "hr:update"], false)
  const employee = mapEmployee(row as EmployeeDbRow, openByEmployee)
  if (canManagePeople && !employee.leftAt) {
    const pin = (row as EmployeeDbRow).clock_pin
    employee.clockPin = typeof pin === "string" && CLOCK_PIN_RE.test(pin) ? pin : null
  }

  let imageUrl: string | null = null
  if (row.user_id) {
    const { data: profile } = await supabase
      .from("users")
      .select("image_url")
      .eq("id", row.user_id)
      .maybeSingle()
    imageUrl = profile?.image_url ?? null
  }

  return {
    success: true,
    data: {
      employee,
      punches,
      francos,
      payments,
      imageUrl,
      canManagePeople,
    },
  }
}

export async function ensureEmployeesFromMembers(
  supabase: SupabaseClient,
  popId: string,
  members: MemberRow[],
): Promise<void> {
  const { data: existing } = await supabase
    .from("pop_employees")
    .select("id, user_id, email, first_name, last_name")
    .eq("pop_id", popId)

  const known = new Set(
    (existing || [])
      .map((row) => row.user_id)
      .filter(Boolean)
      .map((id) => String(id)),
  )
  const stubIdsByUser = new Map<string, string>()
  for (const row of existing || []) {
    if (row.user_id && isEmployeeStubName(row.first_name, row.last_name)) {
      stubIdsByUser.set(String(row.user_id), String(row.id))
    }
  }

  const missing = members.filter(
    (member) => member.isActive && member.userId && !known.has(member.userId),
  )
  const stubsToHeal = members.filter(
    (member) => member.isActive && member.userId && stubIdsByUser.has(member.userId),
  )
  if (missing.length === 0 && stubsToHeal.length === 0) return

  for (const member of stubsToHeal) {
    const employeeId = stubIdsByUser.get(member.userId)
    if (!employeeId) continue
    await supabase
      .from("pop_employees")
      .update({
        first_name: member.firstName.trim() || "Persona",
        last_name: member.lastName.trim(),
      })
      .eq("pop_id", popId)
      .eq("id", employeeId)
  }

  const ownerStubs = missing.filter((member) => member.isOwner)
  if (ownerStubs.length === 0) return

  const reservedPins = new Set<string>()
  const ownerRows: Array<Record<string, string | null>> = []
  for (const member of ownerStubs) {
    const clockPin = await allocateClockPin(supabase, popId, reservedPins)
    ownerRows.push({
      pop_id: popId,
      user_id: member.userId,
      first_name: member.firstName.trim() || "Persona",
      last_name: member.lastName.trim(),
      job_title: "Dueño",
      clock_pin: clockPin,
    })
  }
  await supabase.from("pop_employees").insert(ownerRows)
}

function employeeToUpsertBody(row: EmployeeDbRow): UpsertEmployeeBody {
  return {
    firstName: String(row.first_name ?? ""),
    lastName: String(row.last_name ?? ""),
    jobTitle: String(row.job_title ?? ""),
    documentNumber: String(row.document_number ?? ""),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    monthlySalary:
      row.monthly_salary == null || row.monthly_salary === ""
        ? ""
        : String(row.monthly_salary),
    hiredAt: String(row.hired_at ?? ""),
    notes: String(row.notes ?? ""),
  }
}

export async function updateEmployee(
  supabase: SupabaseClient,
  popId: string,
  employeeId: string,
  patch: PatchEmployeeBody,
  audit: MutationAuditCtx,
): Promise<
  | { success: true; id: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }
> {
  const { data: current, error } = await supabase
    .from("pop_employees")
    .select(EMPLOYEE_SELECT)
    .eq("pop_id", popId)
    .eq("id", employeeId)
    .maybeSingle()
  if (error) {
    return { success: false, error: error.message, status: 500 }
  }
  if (!current) {
    return {
      success: false,
      error: "No encontramos a esa persona.",
      status: 404,
    }
  }
  return upsertEmployee(
    supabase,
    popId,
    mergePatch(employeeToUpsertBody(current as EmployeeDbRow), {
      ...patch,
      id: employeeId,
    }),
    audit,
  )
}

export async function upsertEmployee(
  supabase: SupabaseClient,
  popId: string,
  input: UpsertEmployeeBody,
  audit: MutationAuditCtx,
): Promise<
  | { success: true; id: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }
> {
  const firstName = input.firstName.trim()
  if (!firstName) {
    return { success: false, error: "El nombre es obligatorio.", status: 400 }
  }

  const salary = parseSalaryInput(input.monthlySalary)
  if (salary === "invalid") {
    return { success: false, error: "El sueldo no es válido.", status: 400 }
  }

  const payload = {
    pop_id: popId,
    first_name: firstName,
    last_name: input.lastName.trim(),
    job_title: input.jobTitle.trim() || null,
    document_number: input.documentNumber.trim() || null,
    email: input.email.trim().toLowerCase() || null,
    phone: input.phone.trim() || null,
    monthly_salary: salary,
    hired_at: input.hiredAt.trim() || null,
    notes: input.notes.trim() || null,
  }

  if (input.id) {
    const applied = await auditedUpdate(supabase, {
      kind: "hr.employee.patch",
      table: "pop_employees",
      id: input.id,
      row: payload,
      ctx: audit,
      popId,
      previous: { id: input.id },
      next: payload,
    })
    if (!applied.success) {
      const msg = applied.error || "No se pudo guardar."
      if (msg.includes("23505") || msg.toLowerCase().includes("duplicate")) {
        return {
          success: false,
          error: "Ya hay alguien activo con ese correo.",
          status: 409,
        }
      }
      return { success: false, error: msg, status: applied.status }
    }
    return { success: true, id: input.id }
  }

  const clockPin = await allocateClockPin(supabase, popId)
  if (!clockPin) {
    return {
      success: false,
      error: "No se pudo generar un PIN de fichaje.",
      status: 500,
    }
  }

  const id = randomUUID()
  const applied = await auditedInsert(supabase, {
    kind: "hr.employee.create",
    table: "pop_employees",
    row: { id, ...payload, clock_pin: clockPin },
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    const msg = applied.error || "No se pudo guardar."
    if (msg.includes("23505") || msg.toLowerCase().includes("duplicate")) {
      return {
        success: false,
        error: "Ya hay alguien activo con ese correo.",
        status: 409,
      }
    }
    return { success: false, error: msg, status: applied.status }
  }
  return { success: true, id }
}

export async function markEmployeeLeft(
  supabase: SupabaseClient,
  popId: string,
  employeeId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const today = new Date().toISOString().slice(0, 10)
  const clockedOutAt = new Date().toISOString()
  const { data: openPunches, error: punchErr } = await supabase
    .from("pop_employee_attendance")
    .select("id")
    .eq("pop_id", popId)
    .eq("employee_id", employeeId)
    .is("clocked_out_at", null)
  if (punchErr) return { success: false, error: punchErr.message, status: 500 }

  const applied = await applyWithAudit(supabase, {
    kind: "hr.employee.left",
    ctx: audit,
    popId,
    resourceId: employeeId,
    previous: null,
    next: { left_at: today },
    ops: [
      ...(openPunches ?? []).map((row) => ({
        op: "update" as const,
        table: "pop_employee_attendance",
        id: String(row.id),
        row: { clocked_out_at: clockedOutAt },
      })),
      {
        op: "update" as const,
        table: "pop_employees",
        id: employeeId,
        row: { left_at: today },
      },
    ],
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function markEmployeeReturned(
  supabase: SupabaseClient,
  popId: string,
  employeeId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: employee, error: lookErr } = await supabase
    .from("pop_employees")
    .select("id, left_at, clock_pin")
    .eq("pop_id", popId)
    .eq("id", employeeId)
    .maybeSingle()
  if (lookErr) return { success: false, error: lookErr.message, status: 500 }
  if (!employee) {
    return { success: false, error: "No encontramos a esa persona.", status: 404 }
  }
  if (!employee.left_at) {
    return { success: false, error: "Esa persona ya está en el equipo.", status: 400 }
  }

  const currentPin =
    typeof employee.clock_pin === "string" && CLOCK_PIN_RE.test(employee.clock_pin)
      ? employee.clock_pin
      : null
  let nextPin = currentPin
  if (currentPin) {
    const { data: conflict } = await supabase
      .from("pop_employees")
      .select("id")
      .eq("pop_id", popId)
      .eq("clock_pin", currentPin)
      .is("left_at", null)
      .neq("id", employeeId)
      .maybeSingle()
    if (conflict) nextPin = null
  }
  if (!nextPin) {
    nextPin = await allocateClockPin(supabase, popId, new Set(), employeeId)
    if (!nextPin) {
      return {
        success: false,
        error: "No se pudo generar un PIN de fichaje.",
        status: 500,
      }
    }
  }

  const applied = await auditedUpdate(supabase, {
    kind: "hr.employee.returned",
    table: "pop_employees",
    id: employeeId,
    row: { left_at: null, clock_pin: nextPin },
    ctx: audit,
    popId,
    previous: employee,
    next: { ...employee, left_at: null },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function clockEmployeeIn(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  employeeId: string,
  audit?: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: employee } = await supabase
    .from("pop_employees")
    .select("id, left_at")
    .eq("pop_id", popId)
    .eq("id", employeeId)
    .maybeSingle()
  if (!employee) {
    return { success: false, error: "No encontramos a esa persona.", status: 404 }
  }
  if (employee.left_at) {
    return {
      success: false,
      error: "Esa persona ya no trabaja en este local.",
      status: 400,
    }
  }

  const timeZone = await loadPopTimeZone(supabase, popId, popSiteId)
  const today = entryDateIsoInTimezone(timeZone)
  const { data: todayMark } = await supabase
    .from("pop_employee_francos")
    .select("id, kind")
    .eq("pop_id", popId)
    .eq("employee_id", employeeId)
    .eq("day", today)
    .maybeSingle()
  if (todayMark) {
    return {
      success: false,
      error:
        todayMark.kind === "falta"
          ? "Hoy está marcada falta. Sacala si vino a trabajar."
          : "Hoy está de franco. Sacalo si vino a trabajar.",
      status: 400,
    }
  }

  const attendanceRow = {
    id: randomUUID(),
    pop_id: popId,
    employee_id: employeeId,
  }
  if (!audit) {
    const { error } = await supabase.from("pop_employee_attendance").insert({
      pop_id: popId,
      employee_id: employeeId,
    })
    if (error) {
      if (error.code === "23505") {
        return { success: false, error: "Ya está en el local.", status: 409 }
      }
      return { success: false, error: error.message, status: 500 }
    }
    return { success: true }
  }

  const applied = await auditedInsert(supabase, {
    kind: "hr.employee.clock_in",
    table: "pop_employee_attendance",
    row: attendanceRow,
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    const msg = applied.error || "No se pudo fichar la entrada."
    if (msg.includes("23505") || msg.toLowerCase().includes("duplicate")) {
      return { success: false, error: "Ya está en el local.", status: 409 }
    }
    return { success: false, error: msg, status: applied.status }
  }
  return { success: true }
}

export async function clockEmployeeOut(
  supabase: SupabaseClient,
  popId: string,
  employeeId: string,
  audit?: MutationAuditCtx,
): Promise<MutateResult> {
  const clockedOutAt = new Date().toISOString()
  if (!audit) {
    const { data, error } = await supabase
      .from("pop_employee_attendance")
      .update({ clocked_out_at: clockedOutAt })
      .eq("pop_id", popId)
      .eq("employee_id", employeeId)
      .is("clocked_out_at", null)
      .select("id")
    if (error) return { success: false, error: error.message, status: 500 }
    if (!data?.length) {
      return { success: false, error: "No está marcada la entrada.", status: 400 }
    }
    return { success: true }
  }

  const { data, error } = await supabase
    .from("pop_employee_attendance")
    .select("id")
    .eq("pop_id", popId)
    .eq("employee_id", employeeId)
    .is("clocked_out_at", null)
  if (error) return { success: false, error: error.message, status: 500 }
  if (!data?.length) {
    return { success: false, error: "No está marcada la entrada.", status: 400 }
  }

  const applied = await applyWithAudit(supabase, {
    kind: "hr.employee.clock_out",
    ctx: audit,
    popId,
    resourceId: employeeId,
    previous: data,
    next: { clocked_out_at: clockedOutAt },
    ops: data.map((row) => ({
      op: "update" as const,
      table: "pop_employee_attendance",
      id: String(row.id),
      row: { clocked_out_at: clockedOutAt },
    })),
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function clockEmployeeByPin(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  pinRaw: string,
): Promise<
  | ({ success: true } & ClockByPinData)
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }
> {
  const pin = pinRaw.trim()
  if (!CLOCK_PIN_RE.test(pin)) {
    return { success: false, error: "PIN incorrecto.", status: 400 }
  }

  const { data: employee, error: lookErr } = await supabase
    .from("pop_employees")
    .select("id, first_name, last_name")
    .eq("pop_id", popId)
    .eq("clock_pin", pin)
    .is("left_at", null)
    .maybeSingle()
  if (lookErr) return { success: false, error: lookErr.message, status: 500 }
  if (!employee) {
    return { success: false, error: "PIN incorrecto.", status: 400 }
  }

  const { data: openPunch, error: openErr } = await supabase
    .from("pop_employee_attendance")
    .select("id")
    .eq("pop_id", popId)
    .eq("employee_id", employee.id)
    .is("clocked_out_at", null)
    .maybeSingle()
  if (openErr) return { success: false, error: openErr.message, status: 500 }

  const result = openPunch
    ? await clockEmployeeOut(supabase, popId, String(employee.id))
    : await clockEmployeeIn(supabase, popId, popSiteId, String(employee.id))
  if (!result.success) return result

  return {
    success: true,
    action: openPunch ? "out" : "in",
    firstName: String(employee.first_name ?? ""),
    lastName: String(employee.last_name ?? ""),
  }
}

export async function rotateEmployeeClockPin(
  supabase: SupabaseClient,
  popId: string,
  employeeId: string,
): Promise<
  | { success: true; clockPin: string }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const { data: employee, error: lookErr } = await supabase
    .from("pop_employees")
    .select("id, left_at")
    .eq("pop_id", popId)
    .eq("id", employeeId)
    .maybeSingle()
  if (lookErr) return { success: false, error: lookErr.message, status: 500 }
  if (!employee) {
    return { success: false, error: "No encontramos a esa persona.", status: 404 }
  }
  if (employee.left_at) {
    return {
      success: false,
      error: "Esa persona ya no trabaja en este local.",
      status: 400,
    }
  }

  const clockPin = await allocateClockPin(supabase, popId, new Set(), employeeId)
  if (!clockPin) {
    return {
      success: false,
      error: "No se pudo generar un PIN de fichaje.",
      status: 500,
    }
  }

  const { error } = await supabase
    .from("pop_employees")
    .update({ clock_pin: clockPin })
    .eq("pop_id", popId)
    .eq("id", employeeId)
  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true, clockPin }
}

export async function markEmployeeFranco(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  employeeId: string,
  day: string,
  kind: "franco" | "falta" = "franco",
  audit?: MutationAuditCtx,
): Promise<MutateResult> {
  const francoDay = asCalendarDay(day)
  if (!CALENDAR_DAY_RE.test(francoDay)) {
    return { success: false, error: "Elegí un día.", status: 400 }
  }

  const { data: employee } = await supabase
    .from("pop_employees")
    .select("id, left_at")
    .eq("pop_id", popId)
    .eq("id", employeeId)
    .maybeSingle()
  if (!employee) {
    return { success: false, error: "No encontramos a esa persona.", status: 404 }
  }
  if (employee.left_at && francoDay >= asCalendarDay(String(employee.left_at))) {
    return {
      success: false,
      error: "Esa persona ya no trabaja en este local.",
      status: 400,
    }
  }

  const timeZone = await loadPopTimeZone(supabase, popId, popSiteId)
  const { data: punchRows } = await supabase
    .from("pop_employee_attendance")
    .select("clocked_in_at")
    .eq("pop_id", popId)
    .eq("employee_id", employeeId)

  const workedThatDay = (punchRows || []).some(
    (punch) =>
      timestampToLocalDateIso(String(punch.clocked_in_at ?? ""), timeZone) ===
      francoDay,
  )
  if (workedThatDay) {
    return {
      success: false,
      error: "Ese día ya tiene llegada. No puede ser franco ni falta.",
      status: 400,
    }
  }

  const francoRow = {
    id: randomUUID(),
    pop_id: popId,
    employee_id: employeeId,
    day: francoDay,
    kind,
  }
  if (!audit) {
    const { error } = await supabase.from("pop_employee_francos").insert({
      pop_id: popId,
      employee_id: employeeId,
      day: francoDay,
      kind,
    })
    if (error) {
      if (error.code === "23505") {
        return {
          success: false,
          error: "Ese día ya está marcado.",
          status: 409,
        }
      }
      return { success: false, error: error.message, status: 500 }
    }
    return { success: true }
  }

  const applied = await auditedInsert(supabase, {
    kind: "hr.employee.franco",
    table: "pop_employee_francos",
    row: francoRow,
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    const msg = applied.error || "No se pudo marcar el día."
    if (msg.includes("23505") || msg.toLowerCase().includes("duplicate")) {
      return { success: false, error: "Ese día ya está marcado.", status: 409 }
    }
    return { success: false, error: msg, status: applied.status }
  }
  return { success: true }
}

export async function removeEmployeeFranco(
  supabase: SupabaseClient,
  popId: string,
  employeeId: string,
  francoId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data, error } = await supabase
    .from("pop_employee_francos")
    .select("id")
    .eq("pop_id", popId)
    .eq("employee_id", employeeId)
    .eq("id", francoId)
    .maybeSingle()
  if (error) return { success: false, error: error.message, status: 500 }
  if (!data?.id) {
    return { success: false, error: "No encontramos ese franco.", status: 404 }
  }
  const applied = await auditedDelete(supabase, {
    kind: "hr.employee.franco.delete",
    table: "pop_employee_francos",
    id: francoId,
    ctx: audit,
    popId,
    previous: data,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
