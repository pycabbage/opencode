import { expect, test } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { OpenCode } from "@opencode/client/promise"
import { streamTurn } from "../../src/acp/event"

test("acp prompt resolves after ordered turn updates", async () => {
  let events: Bun.ServerWebSocket<unknown> | undefined
  const updates: Parameters<AgentSideConnection["sessionUpdate"]>[0][] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/api/event") {
        if (server.upgrade(request)) return
        return new Response(null, { status: 426 })
      }
      if (url.pathname === "/api/session/ses_test/prompt") {
        const body: unknown = await request.json()
        if (!body || typeof body !== "object") {
          return new Response(null, { status: 400 })
        }
        const id = "id" in body ? body.id : undefined
        if (typeof id !== "string") return new Response(null, { status: 400 })
        queueMicrotask(() => {
          if (!events) return
          send(events, {
            id: "evt_promoted",
            created: 1,
            type: "session.inbox.delivered",
            data: { sessionID: "ses_test", inboxID: id },
          })
          send(events, {
            id: "evt_text",
            created: 2,
            type: "session.text.delta",
            data: { sessionID: "ses_test", assistantMessageID: "msg_assistant", ordinal: 0, delta: "hello" },
          })
          send(events, {
            id: "evt_step",
            created: 3,
            type: "session.step.ended",
            data: {
              sessionID: "ses_test",
              assistantMessageID: "msg_assistant",
              finish: "stop",
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          })
          send(events, {
            id: "evt_done",
            created: 4,
            type: "session.execution.succeeded",
            data: { sessionID: "ses_test" },
          })
        })
        return Response.json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_test/message/msg_assistant") {
        return Response.json({
          data: {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "test-model" },
            content: [{ type: "text", text: "hello" }],
            finish: "stop",
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, completed: 4 },
          },
        })
      }
      return new Response(null, { status: 404 })
    },
    websocket: {
      open(socket) {
        events = socket
        send(socket, { id: "evt_connected", type: "server.connected", data: {} })
      },
      message() {},
      close(socket) {
        if (events === socket) events = undefined
      },
    },
  })
  const client = OpenCode.make({ baseUrl: server.url.toString() })

  try {
    const id = "msg_prompt"
    const response = await streamTurn({
      client,
      connection: {
        sessionUpdate: async (update) => {
          updates.push(update)
        },
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
      sessionID: "ses_test",
      cwd: "/workspace",
      start: { type: "input", id },
      writeTextFile: false,
      control: { cancelled: false, admission: new AbortController() },
      submit: () => client.session.prompt({ sessionID: "ses_test", id, text: "hi" }),
    })

    expect(updates).toEqual([
      {
        sessionId: "ses_test",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_assistant",
          content: { type: "text", text: "hello" },
        },
      },
    ])
    expect(response).toMatchObject({ stopReason: "end_turn", usage: { totalTokens: 2 } })
  } finally {
    events?.close()
    await server.stop(true)
  }

  function send(socket: Bun.ServerWebSocket<unknown>, event: unknown) {
    socket.send(JSON.stringify(event))
  }
})

test("acp action resolves without prompt lifecycle events", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/api/event") return new Response(null, { status: 404 })
      if (server.upgrade(request)) return
      return new Response(null, { status: 426 })
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: "server.connected", data: {} }))
      },
      message() {},
      close() {},
    },
  })

  try {
    const response = await streamTurn({
      client: OpenCode.make({ baseUrl: server.url.toString() }),
      connection: {
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
      sessionID: "ses_test",
      cwd: "/workspace",
      start: { type: "input", id: "msg_action" },
      writeTextFile: false,
      action: true,
      control: { cancelled: false, admission: new AbortController() },
      submit: async () => {},
    })

    expect(response).toMatchObject({ stopReason: "end_turn" })
  } finally {
    await server.stop(true)
  }
})
