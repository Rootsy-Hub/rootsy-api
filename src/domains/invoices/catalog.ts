const DEFAULT_SITE_ID = "arg"

export type InvoiceArcaRegimen = "fe_general" | "fce_mipyme"

type InvoiceTypeOption = {
  readonly label: string
  readonly arcaCbteTipo: number
  readonly arcaRegimen: InvoiceArcaRegimen
}

const INVOICE_TYPES_ARG: readonly InvoiceTypeOption[] = [
  { label: "Factura A", arcaCbteTipo: 1, arcaRegimen: "fe_general" },
  { label: "Factura B", arcaCbteTipo: 6, arcaRegimen: "fe_general" },
  { label: "Factura C", arcaCbteTipo: 11, arcaRegimen: "fe_general" },
  { label: "Nota de crédito A", arcaCbteTipo: 3, arcaRegimen: "fe_general" },
  { label: "Nota de crédito B", arcaCbteTipo: 8, arcaRegimen: "fe_general" },
  { label: "Nota de crédito C", arcaCbteTipo: 13, arcaRegimen: "fe_general" },
  { label: "Nota de débito A", arcaCbteTipo: 2, arcaRegimen: "fe_general" },
  { label: "Nota de débito B", arcaCbteTipo: 7, arcaRegimen: "fe_general" },
  { label: "Nota de débito C", arcaCbteTipo: 12, arcaRegimen: "fe_general" },
  { label: "Recibo A", arcaCbteTipo: 4, arcaRegimen: "fe_general" },
  { label: "Recibo B", arcaCbteTipo: 9, arcaRegimen: "fe_general" },
  { label: "Recibo C", arcaCbteTipo: 15, arcaRegimen: "fe_general" },
  {
    label: "Factura de crédito electrónica MiPyME (FCE) A",
    arcaCbteTipo: 201,
    arcaRegimen: "fce_mipyme",
  },
  {
    label: "Factura de crédito electrónica MiPyME (FCE) B",
    arcaCbteTipo: 206,
    arcaRegimen: "fce_mipyme",
  },
  {
    label: "Factura de crédito electrónica MiPyME (FCE) C",
    arcaCbteTipo: 211,
    arcaRegimen: "fce_mipyme",
  },
  {
    label: "Nota de débito electrónica MiPyME (FCE) A",
    arcaCbteTipo: 202,
    arcaRegimen: "fce_mipyme",
  },
  {
    label: "Nota de débito electrónica MiPyME (FCE) B",
    arcaCbteTipo: 207,
    arcaRegimen: "fce_mipyme",
  },
  {
    label: "Nota de débito electrónica MiPyME (FCE) C",
    arcaCbteTipo: 212,
    arcaRegimen: "fce_mipyme",
  },
  {
    label: "Nota de crédito electrónica MiPyME (FCE) A",
    arcaCbteTipo: 203,
    arcaRegimen: "fce_mipyme",
  },
  {
    label: "Nota de crédito electrónica MiPyME (FCE) B",
    arcaCbteTipo: 208,
    arcaRegimen: "fce_mipyme",
  },
  {
    label: "Nota de crédito electrónica MiPyME (FCE) C",
    arcaCbteTipo: 213,
    arcaRegimen: "fce_mipyme",
  },
]

const TYPES_BY_SITE: Record<string, readonly InvoiceTypeOption[]> = {
  arg: INVOICE_TYPES_ARG,
}

export function findInvoiceTypeByArcaCbteTipo(
  siteId: string,
  arcaCbteTipo: number,
): InvoiceTypeOption | undefined {
  const list = TYPES_BY_SITE[siteId] ?? TYPES_BY_SITE[DEFAULT_SITE_ID]
  return list.find((o) => o.arcaCbteTipo === arcaCbteTipo)
}
