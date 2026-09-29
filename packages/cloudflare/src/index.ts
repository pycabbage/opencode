import { DurableObject } from "cloudflare:workers"
import { Effect, Scope } from "effect"
import type { OpenCodeEvent } from "@opencode/protocol/groups/event"
import { ServerWorkerd } from "@opencode/server/workerd"
import { WorkerdR2 } from "@opencode/core/workerd/r2"

async function readConfigContent(bucket: R2Bucket): Promise<string | undefined> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const r2 = yield* WorkerdR2.Service
      return yield* r2.readConfig()
    }).pipe(
      Effect.provide(WorkerdR2.layer(bucket)),
      Effect.catch((failure) =>
        Effect.sync(() => {
          console.error("failed to read R2 opencode config", failure)
          return undefined
        }),
      ),
    ),
  )
}

export class OpenCode extends DurableObject<Env> {
  private readonly handler: Promise<(request: Request) => Promise<Response>>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.handler = ctx.blockConcurrencyWhile(async () => {
      const content = await readConfigContent(env.WORKERD_R2)
      const scope = await Effect.runPromise(Scope.make())
      return Effect.runPromise(
        ServerWorkerd.create({
          storage: ctx.storage,
          r2: env.WORKERD_R2,
          config: { content },
          onEvent: (event) => this.broadcastEvent(event),
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )
    })
  }

  override async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/event" && request.method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response(null, { status: 426 })

      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      this.ctx.acceptWebSocket(server, ["event"])
      server.serializeAttachment({ kind: "event" })
      server.send(
        JSON.stringify({
          id: `evt_${crypto.randomUUID()}`,
          type: "server.connected",
          data: {},
        }),
      )
      return new Response(null, { status: 101, webSocket: client })
    }
    return (await this.handler)(request)
  }

  // No webSocketClose override: with `web_socket_auto_reply_to_close` (compat date >= 2026-04-07,
  // enabled here since wrangler.jsonc pins 2026-07-15), the runtime auto-completes the close
  // handshake, so a handler whose only job was `socket.close(code, reason)` has nothing left to do.
  override webSocketError(socket: WebSocket, _error: unknown) {
    try {
      socket.close(1011, "WebSocket error")
    } catch {}
  }

  private broadcastEvent(event: OpenCodeEvent) {
    const message = JSON.stringify(event)
    for (const socket of this.ctx.getWebSockets("event")) {
      if (!this.isEventSocket(socket)) continue
      try {
        socket.send(message)
      } catch {
        try {
          socket.close(1011, "Unable to send event")
        } catch {}
      }
    }
  }

  private isEventSocket(socket: WebSocket) {
    return this.ctx.getTags(socket).includes("event") && socket.deserializeAttachment()?.kind === "event"
  }
}

export default {
  fetch(request: Request, env: Env) {
    const id = env.OPENCODE.idFromName("main")
    return env.OPENCODE.get(id).fetch(request)
  },
}
