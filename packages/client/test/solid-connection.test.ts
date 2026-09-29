import { afterEach, beforeEach, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createClientConnection } from "../src/solid"
import { OpenCode, type OpenCodeEvent } from "../src/promise"
import { FakeWebSocket, installFakeWebSocket } from "./fake-websocket"

let restore: () => void
beforeEach(() => {
  restore = installFakeWebSocket()
})
afterEach(() => restore())

const connected = { id: "evt_connected", created: 1, type: "server.connected", data: {} }

function server() {
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
  })
  return { api, sockets: FakeWebSocket.instances }
}

function setup(
  input: ReturnType<typeof server>,
  extra: Partial<Parameters<typeof createClientConnection>[1]> = {},
) {
  const events: OpenCodeEvent[] = []
  return createRoot((dispose) => ({
    events,
    dispose,
    connection: createClientConnection(input.api, {
      flushInterval: 0,
      onEvent: (event) => events.push(event),
      ...extra,
    }),
  }))
}

async function until(check: () => boolean, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("a WebSocket that stays quiet has no application-level keepalive and is not replaced", async () => {
  const fake = server()
  const ctx = setup(fake)
  try {
    await until(() => fake.sockets.length === 1)
    fake.sockets[0].open()
    fake.sockets[0].message(JSON.stringify(connected))
    await until(() => ctx.connection.status() === "connected")

    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(fake.sockets).toHaveLength(1)
    expect(fake.sockets[0].sent).toEqual([])
    expect(fake.sockets[0].readyState).toBe(FakeWebSocket.OPEN)
    expect(ctx.connection.status()).toBe("connected")
    expect(ctx.events).toHaveLength(1)
  } finally {
    ctx.dispose()
  }
})

test("a forced resync replaces the WebSocket immediately and only while connected", async () => {
  const fake = server()
  const ctx = setup(fake)
  try {
    ctx.connection.internal.resync("too early")
    await until(() => fake.sockets.length === 1)
    expect(fake.sockets[0].readyState).toBe(FakeWebSocket.CONNECTING)
    fake.sockets[0].open()
    fake.sockets[0].message(JSON.stringify(connected))
    await until(() => ctx.connection.status() === "connected")

    const started = Date.now()
    ctx.connection.internal.resync("Network connection restored")
    await until(() => fake.sockets.length === 2)
    expect(Date.now() - started).toBeLessThan(500)
    expect(fake.sockets[0].readyState).toBe(FakeWebSocket.CLOSED)
    expect(ctx.connection.internal.history().map((item) => item.data)).toContainEqual({
      status: "disconnected",
      attempt: 1,
      error: "Network connection restored",
    })
    fake.sockets[1].open()
    fake.sockets[1].message(JSON.stringify(connected))
    await until(() => ctx.connection.status() === "connected")
  } finally {
    ctx.dispose()
  }
})

test("an idle watchdog resyncs the connection once its threshold is exceeded", async () => {
  const fake = server()
  const ctx = setup(fake, { idleWatchdog: 80 })
  try {
    await until(() => fake.sockets.length === 1)
    fake.sockets[0].open()
    fake.sockets[0].message(JSON.stringify(connected))
    await until(() => ctx.connection.status() === "connected")

    await until(() => fake.sockets.length === 2)
    expect(fake.sockets[0].readyState).toBe(FakeWebSocket.CLOSED)
    expect(ctx.connection.internal.history().map((item) => item.data)).toContainEqual({
      status: "disconnected",
      attempt: 1,
      error: "Event WebSocket idle watchdog threshold exceeded",
    })
  } finally {
    ctx.dispose()
  }
})

test("an idle watchdog does not resync before its threshold elapses", async () => {
  const fake = server()
  const ctx = setup(fake, { idleWatchdog: 5_000 })
  try {
    await until(() => fake.sockets.length === 1)
    fake.sockets[0].open()
    fake.sockets[0].message(JSON.stringify(connected))
    await until(() => ctx.connection.status() === "connected")

    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(fake.sockets).toHaveLength(1)
    expect(fake.sockets[0].readyState).toBe(FakeWebSocket.OPEN)
    expect(ctx.connection.status()).toBe("connected")
  } finally {
    ctx.dispose()
  }
})

test("a server-closed WebSocket reconnects and reports the disconnect", async () => {
  const fake = server()
  const ctx = setup(fake)
  try {
    await until(() => fake.sockets.length === 1)
    fake.sockets[0].open()
    fake.sockets[0].message(JSON.stringify(connected))
    await until(() => ctx.connection.status() === "connected")

    fake.sockets[0].close()
    await until(() => ctx.connection.status() === "reconnecting")
    expect(ctx.connection.error()).toBe("Event WebSocket disconnected")
    await until(() => fake.sockets.length === 2)
  } finally {
    ctx.dispose()
  }
})
