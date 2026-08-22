import type { SupabaseClient } from "@supabase/supabase-js"
import {
  cobrosByTreasuryLineFromPayments,
  cobrosForCloseFromPayments,
  loadCobrosTurnoPorMedio,
  loadCompletedSalesForSessions,
  loadSalePaymentsForSaleIds,
} from "./cobros.js"
import type { CashRegisterOpenTotals } from "./schema.js"
import {
  computeCashBalance,
  computeEfectivoTeoricoSession,
} from "./sessionCash.js"

export async function getCashRegistersOpenTotals(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: { byRegisterId: Record<string, CashRegisterOpenTotals> } }
  | { success: false; error: string }
> {
  const { data: openSessions, error } = await supabase
    .from("cash_register_sessions")
    .select("id, cash_register_id, opening_cash")
    .eq("pop_id", popId)
    .eq("status", "open")
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudieron cargar los turnos abiertos.",
    }
  }

  const byRegisterId: Record<string, CashRegisterOpenTotals> = {}
  for (const session of openSessions || []) {
    const registerId = String(session.cash_register_id)
    const sessionId = String(session.id)
    const ef = await computeEfectivoTeoricoSession(supabase, popId, sessionId)
    if (!ef.success) {
      byRegisterId[registerId] = {
        cashBalance: await computeCashBalance(
          supabase,
          sessionId,
          Number(session.opening_cash) || 0,
        ),
        openSessionTotals: {
          openingCash: Number(session.opening_cash) || 0,
          ventasEfectivo: 0,
          ingresosCajon: 0,
          egresosCajon: 0,
          efectivoTeoricoEnCajon: Number(session.opening_cash) || 0,
          totalCobradoTurno: null,
          cobrosPorMedio: null,
          cobrosPorCuenta: null,
          cobrosParaCierre: null,
        },
      }
      continue
    }

    const cob = await loadCobrosTurnoPorMedio(supabase, popId, sessionId)
    const sales = await loadCompletedSalesForSessions(supabase, popId, [
      sessionId,
    ])
    const payments = await loadSalePaymentsForSaleIds(
      supabase,
      popId,
      sales.map((s) => s.id),
      false,
    )

    byRegisterId[registerId] = {
      cashBalance: ef.teorico,
      openSessionTotals: {
        openingCash: ef.openingCash,
        ventasEfectivo: ef.ventasEfectivo,
        ingresosCajon: ef.ingresosCajon,
        egresosCajon: ef.egresosCajon,
        efectivoTeoricoEnCajon: ef.teorico,
        totalCobradoTurno: cob.totalCobrado,
        cobrosPorMedio: cob.porMedio,
        cobrosPorCuenta: cobrosByTreasuryLineFromPayments(payments),
        cobrosParaCierre: cobrosForCloseFromPayments(payments),
      },
    }
  }

  return { success: true, data: { byRegisterId } }
}
