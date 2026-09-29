export * as WebSocketEvents from "./websocket-events.js"

import { OpenCodeEvent } from "@opencode/protocol/groups/event"
import { Effect, Queue, Schema, Stream } from "effect"
import { Socket } from "effect/unstable/socket"
import { ClientError } from "./generated/client-error.js"

/**
 * Resolves the event WebSocket URL from the same `baseUrl` the REST surface uses, applying the
 * same fallback REST already applies when `baseUrl` is omitted.
 *
 * `HttpApiClient.make` (effect/unstable/httpapi) only rewrites a request's URL when `baseUrl` is
 * supplied (`HttpClientRequest.prependUrl`); when it is omitted, the request path is left relative
 * and handed to the platform `HttpClient`, whose underlying `fetch` resolves it — in a browser,
 * against the document's base URL (ordinarily `location.href`).
 *
 * There is no equivalent "leave it relative" option for `new WebSocket(...)`: a WebSocket URL must
 * carry a `ws:`/`wss:` scheme, so a bare relative path cannot be handed to the constructor the way a
 * relative path can be handed to `fetch`. To land on the same origin REST would, this resolves
 * against `globalThis.location` directly instead. With no `baseUrl` and no `location` (e.g. Node/Bun
 * without a DOM), REST already has nothing to resolve a relative path against either, so this fails
 * the same way rather than silently guessing a host.
 *
 * A browser cannot set an `Authorization` header on a WebSocket upgrade request, so `authToken` —
 * the same Base64 `username:password` REST already sends as `Authorization: Basic <token>` — is
 * carried as the `auth_token` query parameter instead, matching
 * `packages/server/src/middleware/authorization.ts`'s `credentialFromRequest`.
 */
function resolveUrl(baseUrl: URL | string | undefined, authToken: string | undefined) {
  return Effect.try({
    try: () => {
      const base = baseUrl !== undefined ? new URL(baseUrl.toString()) : new URL(globalThis.location.href)
      // A leading slash would replace any path prefix on baseUrl, so join relative to it (mirrors
      // the generated Promise/Effect REST clients' own baseUrl handling).
      if (!base.pathname.endsWith("/")) base.pathname += "/"
      const url = new URL("api/event", base)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      if (authToken !== undefined) url.searchParams.set("auth_token", authToken)
      return url.toString()
    },
    catch: (cause) => new ClientError({ cause }),
  })
}

function decode(line: string) {
  return Effect.try({
    try: () => JSON.parse(line) as unknown,
    catch: (cause) => new ClientError({ cause }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OpenCodeEvent)),
    Effect.mapError((cause) => (cause instanceof ClientError ? cause : new ClientError({ cause }))),
  )
}

/**
 * Subscribes to the server event WebSocket, decoding each frame as a typed `OpenCodeEvent`. Opens
 * one WebSocket per subscription (callers that want a shared connection compose this with
 * `SharedEvents.make`, as the Promise and Effect clients both do). No ping/pong: liveness is the
 * socket's own close/error events, same as `packages/server/src/handlers/event.ts` on the wire.
 *
 * `authToken` is the Base64 `username:password` REST sends as `Authorization: Basic <token>`;
 * pass it when the caller has credentials configured so the upgrade is not treated as
 * unauthenticated. Omitted (or `undefined`) for an unauthenticated server, matching REST.
 *
 * Built on `Socket.makeWebSocket` (acquire/release around `globalThis.WebSocket`, matching
 * `packages/ai/src/route/transport/websocket.ts`'s `open`/`fromWebSocket` pattern) and
 * `Socket.runRaw`, whose per-frame handler decodes and offers to a `Queue` — the same
 * queue-offering shape that transport uses, adapted here to `Stream.callback` instead of a
 * hand-rolled `Effect.callback` + `Queue` pair since `Stream.callback` already is that pairing.
 */
export function subscribe(
  baseUrl: URL | string | undefined,
  authToken?: string,
): Stream.Stream<OpenCodeEvent, ClientError, Socket.WebSocketConstructor> {
  return Stream.unwrap(
    Effect.map(resolveUrl(baseUrl, authToken), (url) =>
      Stream.callback<OpenCodeEvent, ClientError, Socket.WebSocketConstructor>((queue) =>
        Effect.gen(function* () {
          const socket = yield* Socket.makeWebSocket(url)
          yield* socket
            .runRaw((data) => {
              const line = typeof data === "string" ? data : new TextDecoder().decode(data)
              return decode(line).pipe(Effect.flatMap((event) => Queue.offer(queue, event)))
            })
            .pipe(
              Effect.mapError((error) => (error instanceof ClientError ? error : new ClientError({ cause: error }))),
              Effect.matchCauseEffect({
                onSuccess: () => Queue.end(queue),
                onFailure: (cause) => Queue.failCause(queue, cause),
              }),
            )
        }),
      ),
    ),
  )
}
