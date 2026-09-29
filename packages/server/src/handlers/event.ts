import { Bus } from "@opencode/core/bus"
import { Event } from "@opencode/schema/event"
import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { EventFeed } from "../event-feed"

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const feed = yield* EventFeed.Service
    return handlers.handleRaw("event.subscribe", (ctx) =>
      Effect.gen(function* () {
        if (ctx.request.headers.upgrade?.toLowerCase() !== "websocket")
          return HttpServerResponse.empty({ status: 426 })

        // `HttpServerRequest.fromWeb` — used by `ServerFetch.make`'s `HttpEffect.toWebHandlerWith`
        // (see packages/server/src/fetch.ts) — always fails this getter; effect's web-standard
        // `ServerRequestImpl.upgrade` has no socket to expose (see effect's HttpServerRequest.ts).
        // In production this branch is unreachable: the Durable Object intercepts the Upgrade
        // request before this handler runs (packages/cloudflare/src/index.ts), and Node serving
        // goes through `NodeHttpServer`, whose `upgrade` succeeds because it wires the socket from
        // the underlying `http.Server`'s `upgrade` event. Report the mismatch with an explicit
        // status instead of dying so it is diagnosable if this path is ever reached some other way.
        const upgraded = yield* Effect.result(ctx.request.upgrade)
        if (upgraded._tag === "Failure")
          return HttpServerResponse.text(
            "This server process cannot upgrade requests to WebSocket connections on this request path",
            { status: 501 },
          )
        const socket = upgraded.success
        const write = yield* socket.writer
        const connected = {
          id: Event.ID.create(),
          type: "server.connected",
          data: {},
        } as const
        const output = Stream.unwrap(
          feed.subscribe.pipe(Effect.map((live) => Stream.make(JSON.stringify(connected)).pipe(Stream.concat(live)))),
        )
        const send = Stream.runForEach(output, write)
        const awaitClientClose = socket.runRaw(() => Effect.void)
        yield* Effect.race(send, awaitClientClose).pipe(
          Effect.catch((error) => Effect.logWarning("event websocket send loop ended with error", { error })),
        )
        return HttpServerResponse.empty()
      }),
    )
  }),
)
