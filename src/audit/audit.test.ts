import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  signRootsyAiExecution,
  verifyRootsyAiExecutionHeader,
} from "./hmacCore.js"
import { jsonDiff, requestApprovalKeys, redactAuditJson } from "./types.js"

describe("audit helpers", () => {
  it("arma hermanas request_approval", () => {
    assert.deepEqual(requestApprovalKeys(["articles:update", "sale:create"]), [
      "articles:update:request_approval",
      "sale:create:request_approval",
    ])
  })

  it("diff solo campos que cambian", () => {
    const diff = jsonDiff(
      { name: "Agua", salePrice: 100, iva: 21 },
      { name: "Agua", salePrice: 200, iva: 21 },
    )
    assert.deepEqual(diff.previous_state, { salePrice: 100 })
    assert.deepEqual(diff.new_state, { salePrice: 200 })
  })

  it("redacta secretos", () => {
    const redacted = redactAuditJson({
      name: "Ana",
      clock_pin: "1234",
      code_hash: "x",
    }) as Record<string, unknown>
    assert.equal(redacted.name, "Ana")
    assert.equal("clock_pin" in redacted, false)
    assert.equal("code_hash" in redacted, false)
  })

  it("verifica HMAC de Rootsy IA", () => {
    const secret = "x".repeat(32)
    const signed = signRootsyAiExecution({
      secret,
      userId: "user-1",
      popId: "pop-1",
      method: "PATCH",
      path: "/v1/pops/pop-1/articles/a",
      timestamp: 1_700_000_000_000,
      nonce: "abc",
    })
    assert.equal(
      verifyRootsyAiExecutionHeader({
        header: signed,
        secret,
        userId: "user-1",
        popId: "pop-1",
        method: "patch",
        path: "/v1/pops/pop-1/articles/a",
        now: 1_700_000_000_000,
      }),
      true,
    )
    assert.equal(
      verifyRootsyAiExecutionHeader({
        header: signed,
        secret,
        userId: "user-1",
        popId: "pop-1",
        method: "PATCH",
        path: "/v1/pops/pop-1/articles/a",
        now: 1_700_000_000_000 + 3 * 60 * 1000,
      }),
      false,
    )
  })
})
