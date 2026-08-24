import type { SupabaseClient } from "@supabase/supabase-js"
import { hasAnyPermission } from "../../sidecar/permissions.js"
import { CLOCK_PIN_RE } from "./schema.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 404 | 500 }

export type ClockStationData = {
  canManageStation: boolean
  clockStationPin: string | null
}

function randomStationPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000))
}

async function readStationPin(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; pin: string | null }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const { data, error } = await supabase
    .from("pops")
    .select("clock_station_pin")
    .eq("id", popId)
    .maybeSingle()
  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) return { success: false, error: "POP no encontrado", status: 404 }
  const pin =
    typeof data.clock_station_pin === "string" &&
    CLOCK_PIN_RE.test(data.clock_station_pin)
      ? data.clock_station_pin
      : null
  return { success: true, pin }
}

async function writeStationPin(
  supabase: SupabaseClient,
  popId: string,
  pin: string,
): Promise<MutateResult> {
  const { error } = await supabase
    .from("pops")
    .update({ clock_station_pin: pin })
    .eq("id", popId)
  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}

async function ensureStationPin(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; pin: string }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const loaded = await readStationPin(supabase, popId)
  if (!loaded.success) return loaded
  if (loaded.pin) return { success: true, pin: loaded.pin }
  const pin = randomStationPin()
  const saved = await writeStationPin(supabase, popId, pin)
  if (!saved.success) return saved
  return { success: true, pin }
}

export async function getClockStation(
  supabase: SupabaseClient,
  popId: string,
  keys: readonly string[],
  isOwner: boolean,
): Promise<
  | { success: true; data: ClockStationData }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const canManageStation =
    isOwner || hasAnyPermission(keys, ["hr:create", "hr:update"], false)
  const ensured = await ensureStationPin(supabase, popId)
  if (!ensured.success) return ensured
  return {
    success: true,
    data: {
      canManageStation,
      clockStationPin: canManageStation ? ensured.pin : null,
    },
  }
}

export async function unlockClockStation(
  supabase: SupabaseClient,
  popId: string,
  pinRaw: string,
): Promise<MutateResult> {
  const pin = pinRaw.trim()
  if (!CLOCK_PIN_RE.test(pin)) {
    return { success: false, error: "PIN incorrecto.", status: 400 }
  }
  const loaded = await readStationPin(supabase, popId)
  if (!loaded.success) return loaded
  if (!loaded.pin || loaded.pin !== pin) {
    return { success: false, error: "PIN incorrecto.", status: 400 }
  }
  return { success: true }
}

export async function rotateClockStationPin(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; clockStationPin: string }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const pin = randomStationPin()
  const saved = await writeStationPin(supabase, popId, pin)
  if (!saved.success) return saved
  return { success: true, clockStationPin: pin }
}
