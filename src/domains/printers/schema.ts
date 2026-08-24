import { z } from "zod"

function trimOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export const upsertPrinterBodySchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio."),
  isActive: z.boolean(),
  sortOrder: z.coerce.number().refine(Number.isFinite, "Orden inválido."),
  integrationKind: z.string().optional().default(""),
  connectionHint: z.string().optional().default(""),
})

export type UpsertPrinterBody = z.infer<typeof upsertPrinterBodySchema>
export type PatchPrinterBody = Partial<UpsertPrinterBody>

export type PrinterRow = {
  id: string
  name: string
  isActive: boolean
  sortOrder: number
  integrationKind: string | null
  connectionHint: string | null
}

export function normalizePrinterFields(input: UpsertPrinterBody): {
  name: string
  isActive: boolean
  sortOrder: number
  integrationKind: string | null
  connectionHint: string | null
} {
  return {
    name: input.name.trim(),
    isActive: input.isActive,
    sortOrder: Math.trunc(input.sortOrder),
    integrationKind: trimOrNull(input.integrationKind ?? ""),
    connectionHint: trimOrNull(input.connectionHint ?? ""),
  }
}
