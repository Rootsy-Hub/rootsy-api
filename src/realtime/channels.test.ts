import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  canSubscribeToChannel,
  cajasUserChannel,
  channelsForEvent,
  orderResourceChannel,
  sessionResourceChannel,
} from "./channels.ts"

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

describe("canSubscribeToChannel cajas", () => {
  it("deja entrar a resource:cajas del mismo usuario", () => {
    assert.equal(
      canSubscribeToChannel(cajasUserChannel("u1"), {
        userId: "u1",
        keys: ["sale:read"],
        isOwner: false,
      }),
      true,
    )
  })

  it("no deja entrar a resource:cajas de otro usuario", () => {
    assert.equal(
      canSubscribeToChannel(cajasUserChannel("u2"), {
        userId: "u1",
        keys: ["sale:read"],
        isOwner: false,
      }),
      false,
    )
  })

  it("tampoco deja al owner escuchar la caja de otro", () => {
    assert.equal(
      canSubscribeToChannel(cajasUserChannel("u2"), {
        userId: "u1",
        keys: [],
        isOwner: true,
      }),
      false,
    )
  })
})

describe("channelsForEvent", () => {
  it("si channels está seteado, no manda al domain", () => {
    const sessionId = "sess-1"
    assert.deepEqual(
      channelsForEvent({
        id: "e1",
        seq: 1,
        type: "mesas.checkout_saved",
        popId: "pop-1",
        actorId: "u1",
        occurredAt: "2026-01-01T00:00:00.000Z",
        resource: { type: "session", id: sessionId },
        payload: { sessionId },
        channels: [sessionResourceChannel(sessionId)],
      }),
      [sessionResourceChannel(sessionId)],
    )
  })

  it("comandas van a domain y al resource de la sesión", () => {
    const sessionId = "sess-1"
    assert.deepEqual(
      channelsForEvent({
        id: "e2",
        seq: 2,
        type: "comandas.sent",
        popId: "pop-1",
        actorId: "u1",
        occurredAt: "2026-01-01T00:00:00.000Z",
        resource: { type: "comanda", id: sessionId },
        payload: { sourceKind: "table", sourceId: sessionId },
        channels: ["domain:comandas", sessionResourceChannel(sessionId)],
      }),
      ["domain:comandas", sessionResourceChannel(sessionId)],
    )
  })

  it("cajas van solo al resource del usuario", () => {
    const userId = "11111111-1111-1111-1111-111111111111"
    assert.deepEqual(
      channelsForEvent({
        id: "e3",
        seq: 3,
        type: "cajas.session_closed",
        popId: "pop-1",
        actorId: "u1",
        occurredAt: "2026-01-01T00:00:00.000Z",
        resource: { type: "cajas", id: userId },
        payload: { sessionId: "sess-1" },
        channels: [cajasUserChannel(userId)],
      }),
      [cajasUserChannel(userId)],
    )
  })

  it("sin channels, fanout a domain y resource", () => {
    assert.deepEqual(
      channelsForEvent({
        id: "e1",
        seq: 1,
        type: "mostrador.order_opened",
        popId: "pop-1",
        actorId: "u1",
        occurredAt: "2026-01-01T00:00:00.000Z",
        resource: { type: "order", id: "ord-1" },
        payload: {},
      }),
      ["domain:mostrador", orderResourceChannel("ord-1")],
    )
  })
})
