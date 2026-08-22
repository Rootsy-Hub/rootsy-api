import type { SupabaseClient } from "@supabase/supabase-js"
import { hasAnyPermission } from "../../sidecar/permissions.js"
import {
  entryDateIsoInTimezone,
  timestampToLocalDateIso,
  timezoneForPopLedger,
} from "../operations/timezone.js"
import { asCalendarDay } from "./ids.js"
import {
  CALENDAR_DAY_RE,
  parseSalaryInput,
  type AttendancePunchRow,
  type EmployeeDetailData,
  type EmployeePaymentRow,
  type EmployeeRow,
  type FrancoRow,
  type MemberRow,
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
  }
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
    .select(EMPLOYEE_SELECT)
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
      employee: mapEmployee(row as EmployeeDbRow, openByEmployee),
      punches,
      francos,
      payments,
      imageUrl,
      canManagePeople:
        isOwner || hasAnyPermission(keys, ["hr:create", "hr:update"], false),
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

  await supabase.from("pop_employees").insert(
    ownerStubs.map((member) => ({
      pop_id: popId,
      user_id: member.userId,
      first_name: member.firstName.trim() || "Persona",
      last_name: member.lastName.trim(),
      job_title: "Dueño",
    })),
  )
}

export async function upsertEmployee(
  supabase: SupabaseClient,
  popId: string,
  input: UpsertEmployeeBody,
): Promise<
  | { success: true; id: string }
  | { success: false; error: string; status: 400 | 409 | 500 }
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
    const { error } = await supabase
      .from("pop_employees")
      .update(payload)
      .eq("pop_id", popId)
      .eq("id", input.id)
    if (error) {
      if (error.code === "23505") {
        return {
          success: false,
          error: "Ya hay alguien activo con ese correo.",
          status: 409,
        }
      }
      return { success: false, error: error.message, status: 500 }
    }
    return { success: true, id: input.id }
  }

  const { data, error } = await supabase
    .from("pop_employees")
    .insert(payload)
    .select("id")
    .single()
  if (error || !data) {
    if (error?.code === "23505") {
      return {
        success: false,
        error: "Ya hay alguien activo con ese correo.",
        status: 409,
      }
    }
    return {
      success: false,
      error: error?.message || "No se pudo guardar.",
      status: 500,
    }
  }
  return { success: true, id: String(data.id) }
}

export async function markEmployeeLeft(
  supabase: SupabaseClient,
  popId: string,
  employeeId: string,
): Promise<MutateResult> {
  const today = new Date().toISOString().slice(0, 10)
  await supabase
    .from("pop_employee_attendance")
    .update({ clocked_out_at: new Date().toISOString() })
    .eq("pop_id", popId)
    .eq("employee_id", employeeId)
    .is("clocked_out_at", null)

  const { error } = await supabase
    .from("pop_employees")
    .update({ left_at: today })
    .eq("pop_id", popId)
    .eq("id", employeeId)
  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}

export async function markEmployeeReturned(
  supabase: SupabaseClient,
  popId: string,
  employeeId: string,
): Promise<MutateResult> {
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
  if (!employee.left_at) {
    return { success: false, error: "Esa persona ya está en el equipo.", status: 400 }
  }

  const { error } = await supabase
    .from("pop_employees")
    .update({ left_at: null })
    .eq("pop_id", popId)
    .eq("id", employeeId)
  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}

export async function clockEmployeeIn(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  employeeId: string,
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

export async function clockEmployeeOut(
  supabase: SupabaseClient,
  popId: string,
  employeeId: string,
): Promise<MutateResult> {
  const { data, error } = await supabase
    .from("pop_employee_attendance")
    .update({ clocked_out_at: new Date().toISOString() })
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

export async function markEmployeeFranco(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  employeeId: string,
  day: string,
  kind: "franco" | "falta" = "franco",
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

export async function removeEmployeeFranco(
  supabase: SupabaseClient,
  popId: string,
  employeeId: string,
  francoId: string,
): Promise<MutateResult> {
  const { data, error } = await supabase
    .from("pop_employee_francos")
    .delete()
    .eq("pop_id", popId)
    .eq("employee_id", employeeId)
    .eq("id", francoId)
    .select("id")
  if (error) return { success: false, error: error.message, status: 500 }
  if (!data?.length) {
    return { success: false, error: "No encontramos ese franco.", status: 404 }
  }
  return { success: true }
}
