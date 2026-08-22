import {
  findInvoiceTypeByArcaCbteTipo,
  findInvoiceTypeByLabel,
} from "../invoices/catalog.js"

const SALE_COMPROBANTE_RECIBO_X_LABEL = "Recibo X"

export function findSaleInvoiceTypeByArcaCbteTipo(
  siteId: string,
  arcaCbteTipo: number,
) {
  return findInvoiceTypeByArcaCbteTipo(siteId, arcaCbteTipo)
}

function isInternalSaleComprobante(label: string | null | undefined): boolean {
  return label === SALE_COMPROBANTE_RECIBO_X_LABEL
}

/**
 * Indica si el tipo de comprobante implica registrar IVA débito fiscal
 * (crédito en cuenta IVA a pagar) en el asiento de la venta.
 */
export function saleComprobanteAccruesOutputVat(
  siteId: string,
  label: string | null | undefined,
): boolean {
  if (label == null) return false
  if (isInternalSaleComprobante(label)) return false

  const opt = findInvoiceTypeByLabel(siteId, label)
  if (!opt) return false

  const l = opt.label
  if (l.startsWith("Recibo")) return false
  if (l.startsWith("Factura")) return true
  if (l.startsWith("Nota de cr")) return true
  if (l.startsWith("Nota de d")) return true
  return false
}

export function purchaseComprobanteAccruesInputVat(
  documentKind: string | null | undefined,
): boolean {
  if (documentKind == null || !documentKind.trim()) return false
  const label = documentKind.trim()
  if (label === "Factura A" || label === "Factura B") {
    return true
  }
  return false
}

export function saleComprobanteLabel(sale: {
  arcaInvoice: { tipoLabel: string } | null
  invoiceTypeLabel: string | null
}): string {
  if (sale.arcaInvoice?.tipoLabel) return sale.arcaInvoice.tipoLabel
  if (sale.invoiceTypeLabel) return sale.invoiceTypeLabel
  return "—"
}

export function saleHasComprobante(sale: {
  arcaInvoice: { tipoLabel: string } | null
  invoiceTypeLabel: string | null
}): boolean {
  return Boolean(sale.arcaInvoice || sale.invoiceTypeLabel)
}
