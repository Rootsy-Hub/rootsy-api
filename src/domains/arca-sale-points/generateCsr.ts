import forge from "node-forge"

const CUIT_RE = /^\d{11}$/

function compactCuit(raw: string): string {
  return raw.replace(/\D/g, "")
}

function subjectOrg(razonSocial: string | null, cuit: string): string {
  const name = razonSocial?.trim() || `CUIT ${cuit}`
  return name.slice(0, 64)
}

export function generateArcaCsrAndKey(input: {
  cuit: string
  razonSocial: string | null
}):
  | { success: true; keyPem: string; csrPem: string }
  | { success: false; error: string } {
  const cuit = compactCuit(input.cuit)
  if (!CUIT_RE.test(cuit)) {
    return {
      success: false,
      error: "Configurá el CUIT fiscal del negocio antes de generar el CSR.",
    }
  }

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  const csr = forge.pki.createCertificationRequest()
  csr.publicKey = keys.publicKey
  const serial = `CUIT ${cuit}`
  csr.setSubject([
    { name: "countryName", value: "AR" },
    { name: "organizationName", value: subjectOrg(input.razonSocial, cuit) },
    { name: "commonName", value: serial },
    { name: "serialNumber", value: serial },
  ])
  csr.sign(keys.privateKey, forge.md.sha256.create())

  return {
    success: true,
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    csrPem: forge.pki.certificationRequestToPem(csr),
  }
}
