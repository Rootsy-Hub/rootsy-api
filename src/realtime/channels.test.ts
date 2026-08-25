import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { canSubscribeToChannel } from "./channels.ts"

describe("canSubscribeToChannel catalog", () => {
  it("deja entrar a domain:articles con sale:read", () => {
    assert.equal(
      canSubscribeToChannel("domain:articles", {
        userId: "u1",
        keys: ["sale:read"],
        isOwner: false,
      }),
      true,
    )
  })

  it("deja entrar a domain:categories con sale:read", () => {
    assert.equal(
      canSubscribeToChannel("domain:categories", {
        userId: "u1",
        keys: ["sale:read"],
        isOwner: false,
      }),
      true,
    )
  })

  it("no deja entrar a domain:articles sin permiso de listado", () => {
    assert.equal(
      canSubscribeToChannel("domain:articles", {
        userId: "u1",
        keys: ["chat:read"],
        isOwner: false,
      }),
      false,
    )
  })
})
