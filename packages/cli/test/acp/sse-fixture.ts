import { OpenCode, type OpenCodeEvent, type SessionMessageInfo } from "@opencode/client/promise"

type DurableEvent = Extract<OpenCodeEvent, { durable: unknown }>
type EphemeralEvent = Exclude<OpenCodeEvent, DurableEvent>

type RequestRecord = {
  readonly method: string
  readonly path: string
  readonly body?: unknown
}

type FixtureOptions = {
  readonly onPrompt?: (input: {
    readonly sessionID: string
    readonly id: string
    readonly body: unknown
    readonly signal: AbortSignal
    readonly send: (event: unknown) => void
  }) => void | Promise<void>
  readonly onInterrupt?: (input: {
    readonly sessionID: string
    readonly send: (event: unknown) => void
  }) => boolean | Promise<boolean>
  readonly onPermissionReply?: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly reply: string
    readonly body: unknown
    readonly send: (event: unknown) => void
  }) => void | Promise<void>
  readonly onFormCancel?: (input: {
    readonly sessionID: string
    readonly formID: string
    readonly send: (event: unknown) => void
  }) => void | Promise<void>
}

const ids = { next: 0 }

export function durableEvent<Type extends DurableEvent["type"]>(
  type: Type,
  data: Extract<DurableEvent, { type: Type }>["data"],
) {
  ids.next++
  return {
    id: `evt_${ids.next}`,
    created: ids.next,
    type,
    durable: { aggregateID: "test", seq: ids.next, version: 1 },
    data,
  }
}

export function ephemeralEvent<Type extends EphemeralEvent["type"]>(
  type: Type,
  data: Extract<EphemeralEvent, { type: Type }>["data"],
) {
  ids.next++
  return { id: `evt_${ids.next}`, created: ids.next, type, data }
}

export function createSseFixture(options: FixtureOptions = {}) {
  const sockets = new Set<Bun.ServerWebSocket<unknown>>()
  const requests: RequestRecord[] = []
  const messages = new Map<string, SessionMessageInfo>()

  const send = (event: unknown) => {
    const payload = JSON.stringify(event)
    for (const socket of sockets) {
      try {
        socket.send(payload)
      } catch {
        sockets.delete(socket)
      }
    }
  }

  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined)
      requests.push({ method: request.method, path: url.pathname, ...(body === undefined ? {} : { body }) })

      if (url.pathname === "/api/event") {
        if (server.upgrade(request)) return
        return new Response(null, { status: 426 })
      }

      const prompt = /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname)
      if (prompt?.[1]) {
        const id = stringField(body, "id")
        if (!id) return new Response(null, { status: 400 })
        await options.onPrompt?.({
          sessionID: decodeURIComponent(prompt[1]),
          id,
          body,
          signal: request.signal,
          send,
        })
        return Response.json({ data: { text: stringField(body, "text") ?? "" } })
      }

      const message = /^\/api\/session\/([^/]+)\/message\/([^/]+)$/.exec(url.pathname)
      if (message?.[1] && message[2]) {
        const sessionID = decodeURIComponent(message[1])
        const messageID = decodeURIComponent(message[2])
        return Response.json({
          data: messages.get(`${sessionID}/${messageID}`) ?? messages.get(messageID) ?? assistantMessage(messageID),
        })
      }

      const permission = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(url.pathname)
      if (permission?.[1] && permission[2]) {
        const reply = stringField(body, "decision")
        if (!reply) return new Response(null, { status: 400 })
        await options.onPermissionReply?.({
          sessionID: decodeURIComponent(permission[1]),
          requestID: decodeURIComponent(permission[2]),
          reply,
          body,
          send,
        })
        return new Response(null, { status: 204 })
      }

      const form = /^\/api\/session\/([^/]+)\/form\/([^/]+)$/.exec(url.pathname)
      if (request.method === "DELETE" && form?.[1] && form[2]) {
        await options.onFormCancel?.({
          sessionID: decodeURIComponent(form[1]),
          formID: decodeURIComponent(form[2]),
          send,
        })
        return new Response(null, { status: 204 })
      }

      const interrupt = /^\/api\/session\/([^/]+)\/interrupt$/.exec(url.pathname)
      if (interrupt?.[1]) {
        const interrupted =
          (await options.onInterrupt?.({ sessionID: decodeURIComponent(interrupt[1]), send })) ?? false
        return Response.json({ interrupted })
      }

      return new Response(null, { status: 404 })
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
        socket.send(JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} }))
      },
      message() {},
      close(socket) {
        sockets.delete(socket)
      },
    },
  })

  return {
    client: OpenCode.make({ baseUrl: server.url.toString() }),
    messages,
    requests,
    send,
    async stop() {
      for (const socket of sockets) {
        try {
          socket.close()
        } catch {}
      }
      sockets.clear()
      await server.stop(true)
    },
  }
}

export async function withTimeout<Value>(promise: Promise<Value>, message: string, milliseconds = 2_000) {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(message)), milliseconds)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

function stringField(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" ? field : undefined
}

function assistantMessage(id: string) {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test-model" },
    content: [],
    finish: "stop",
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: 2 },
  } satisfies SessionMessageInfo
}
