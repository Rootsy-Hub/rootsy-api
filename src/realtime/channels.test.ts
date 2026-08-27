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

  it("deja entrar a domain:promotions con sale:read", () => {
    assert.equal(
      canSubscribeToChannel("domain:promotions", {
        userId: "u1",
        keys: ["sale:read"],
        isOwner: false,
      }),
      true,
    )
  })

  it("deja entrar a domain:promotions con promotions:read", () => {
    assert.equal(
      canSubscribeToChannel("domain:promotions", {
        userId: "u1",
        keys: ["promotions:read"],
        isOwner: false,
      }),
      true,
    )
  })

  it("deja entrar a domain:recipes con mesas:read", () => {
    assert.equal(
      canSubscribeToChannel("domain:recipes", {
        userId: "u1",
        keys: ["mesas:read"],
        isOwner: false,
      }),
      true,
    )
  })

  it("deja entrar a domain:recipecategories con recipes:read", () => {
    assert.equal(
      canSubscribeToChannel("domain:recipecategories", {
        userId: "u1",
        keys: ["recipes:read"],
        isOwner: false,
      }),
      true,
    )
  })

  it("no deja entrar a domain:recipes sin permiso de listado", () => {
    assert.equal(
      canSubscribeToChannel("domain:recipes", {
        userId: "u1",
        keys: ["chat:read"],
        isOwner: false,
      }),
      false,
    )
  })

  it("no deja entrar a domain:promotions sin permiso de listado", () => {
    assert.equal(
      canSubscribeToChannel("domain:promotions", {
        userId: "u1",
        keys: ["chat:read"],
        isOwner: false,
      }),
      false,
    )
  })
})

describe("canSubscribeToChannel mesas y comandas", () => {
  it("deja entrar a domain:mesas con mesas:read", () => {
    assert.equal(
      canSubscribeToChannel("domain:mesas", {
        userId: "u1",
        keys: ["mesas:read"],
        isOwner: false,
      }),
      true,
    )
  })

  it("deja entrar a domain:comandas con mesas:read", () => {
    assert.equal(
      canSubscribeToChannel("domain:comandas", {
        userId: "u1",
        keys: ["mesas:read"],
        isOwner: false,
      }),
      true,
    )
  })

  it("deja entrar a domain:comandas con comandas:read", () => {
    assert.equal(
      canSubscribeToChannel("domain:comandas", {
        userId: "u1",
        keys: ["comandas:read"],
        isOwner: false,
      }),
      true,
    )
  })

  it("no deja entrar a domain:comandas sin permiso de mesas o comandas", () => {
    assert.equal(
      canSubscribeToChannel("domain:comandas", {
        userId: "u1",
        keys: ["chat:read"],
        isOwner: false,
      }),
      false,
    )
  })

  it("deja entrar a domain:comandas con mostrador:read", () => {
    assert.equal(
      canSubscribeToChannel("domain:comandas", {
        userId: "u1",
        keys: ["mostrador:read"],
        isOwner: false,
      }),
      true,
    )
  })

  it("deja entrar a domain:mostrador con mostrador:read", () => {
    assert.equal(
      canSubscribeToChannel("domain:mostrador", {
        userId: "u1",
        keys: ["mostrador:read"],
        isOwner: false,
      }),
      true,
    )
  })
})
