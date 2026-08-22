export type ParsedBankStatementLine = {
  lineDate: string
  description: string
  amount: number
  direction: "in" | "out"
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

function parseMoney(raw: string): number | null {
  const t = raw.trim().replace(/\s/g, "").replace(/\./g, "").replace(",", ".")
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  return roundMoney(Math.abs(n))
}

function parseDate(raw: string): string | null {
  const t = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(t)
  if (m) {
    const d = m[1].padStart(2, "0")
    const mo = m[2].padStart(2, "0")
    return `${m[3]}-${mo}-${d}`
  }
  return null
}

function detectDelimiter(headerLine: string): "," | ";" {
  const commas = (headerLine.match(/,/g) || []).length
  const semis = (headerLine.match(/;/g) || []).length
  return semis > commas ? ";" : ","
}

function splitRow(line: string, delim: "," | ";"): string[] {
  return line.split(delim).map((c) => c.trim().replace(/^"|"$/g, ""))
}

function colIndex(headers: string[], names: string[]): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]/g, "")
  const nh = headers.map(norm)
  for (const name of names) {
    const i = nh.indexOf(norm(name))
    if (i >= 0) return i
  }
  return -1
}

export function parseBankStatementCsv(text: string): {
  lines: ParsedBankStatementLine[]
  errors: string[]
} {
  const errors: string[] = []
  const rawLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (rawLines.length === 0) {
    return { lines: [], errors: ["El archivo o texto está vacío."] }
  }

  const delim = detectDelimiter(rawLines[0])
  const headerCells = splitRow(rawLines[0], delim)
  const hasHeader =
    colIndex(headerCells, ["fecha", "date", "fech"]) >= 0 ||
    colIndex(headerCells, ["importe", "amount", "monto"]) >= 0

  const dataRows = hasHeader ? rawLines.slice(1) : rawLines
  const headers = hasHeader ? headerCells : ["fecha", "descripcion", "importe"]

  const iDate = colIndex(headers, ["fecha", "date", "fech"])
  const iDesc = colIndex(headers, [
    "descripcion",
    "description",
    "detalle",
    "concepto",
  ])
  const iAmount = colIndex(headers, ["importe", "amount", "monto", "valor"])
  const iDebit = colIndex(headers, ["debito", "debe", "egreso", "salida"])
  const iCredit = colIndex(headers, ["credito", "haber", "ingreso", "entrada"])

  if (iDate < 0) {
    return {
      lines: [],
      errors: ["No se encontró columna de fecha (fecha, date)."],
    }
  }

  const lines: ParsedBankStatementLine[] = []

  for (let ri = 0; ri < dataRows.length; ri++) {
    const cells = splitRow(dataRows[ri], delim)
    const lineNo = hasHeader ? ri + 2 : ri + 1
    const dateRaw = cells[iDate] ?? ""
    const lineDate = parseDate(dateRaw)
    if (!lineDate) {
      errors.push(`Línea ${lineNo}: fecha inválida «${dateRaw}».`)
      continue
    }

    const description =
      (iDesc >= 0 ? cells[iDesc] : (cells[1] ?? "")).trim() ||
      "Movimiento extracto"

    let amount: number | null = null
    let direction: "in" | "out" | null = null

    if (iDebit >= 0 || iCredit >= 0) {
      const deb = iDebit >= 0 ? parseMoney(cells[iDebit] ?? "") : null
      const cred = iCredit >= 0 ? parseMoney(cells[iCredit] ?? "") : null
      if (cred != null && cred > 0) {
        amount = cred
        direction = "in"
      } else if (deb != null && deb > 0) {
        amount = deb
        direction = "out"
      }
    } else {
      const idx = iAmount >= 0 ? iAmount : 2
      const rawAmt = cells[idx] ?? ""
      const signed = rawAmt
        .trim()
        .replace(/\s/g, "")
        .replace(/\./g, "")
        .replace(",", ".")
      const n = Number(signed)
      if (Number.isFinite(n) && n !== 0) {
        amount = roundMoney(Math.abs(n))
        direction = n >= 0 ? "in" : "out"
      } else {
        const abs = parseMoney(rawAmt)
        if (abs != null && abs > 0) {
          amount = abs
          direction = "out"
        }
      }
    }

    if (amount == null || !direction || amount <= 0) {
      errors.push(`Línea ${lineNo}: importe inválido o cero.`)
      continue
    }

    lines.push({ lineDate, description, amount, direction })
  }

  return { lines, errors }
}
