export * as OpenCode from "./client.js"

import { Context, Effect, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { SharedEvents } from "../shared-events.js"
import { ClientError, OpenCode } from "./generated/index.js"
import { RpcClientRuntime } from "./rpc.js"
import type { RpcCallOptions } from "../promise/rpc.js"
import { WebSocketEvents } from "./websocket-events.js"

const CurrentHeaders = Context.Reference<RpcCallOptions["headers"]>("@opencode/client/effect/rpc/headers", {
  defaultValue: () => undefined,
})

const browserWebSocketConstructor = (url: string, protocols?: string | Array<string>) =>
  new globalThis.WebSocket(url, protocols)

export const make = Effect.fn("OpenCode.make")(function* (options?: {
  readonly baseUrl?: URL | string
  /** Base64 `username:password` Basic-auth credential, matching the `Authorization` header REST sends. Omit for an unauthenticated server. */
  readonly authToken?: string
}) {
  const httpClient = yield* HttpClient.HttpClient
  const raw = yield* OpenCode.make(options).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.mapRequestEffect(httpClient, (request) =>
        Effect.map(CurrentHeaders, (headers) =>
          headers ? HttpClientRequest.setHeaders(request, new Headers(headers)) : request,
        ),
      ),
    ),
  )
  const context = yield* Effect.context<Socket.WebSocketConstructor>().pipe(
    Effect.provideService(Socket.WebSocketConstructor, browserWebSocketConstructor),
  )
  const shared = SharedEvents.make((signal, onActivity) =>
    Stream.toAsyncIterableWith(
      WebSocketEvents.subscribe(options?.baseUrl, options?.authToken).pipe(
        Stream.interruptWhen(RpcClientRuntime.aborted(signal)),
        Stream.tap(() => Effect.sync(onActivity)),
      ),
      context,
    ),
  )
  const subscribe = () =>
    Stream.fromAsyncIterable(shared.subscribe(), (error) => error).pipe(
      Stream.mapError((error) => new ClientError({ cause: error })),
    )
  return {
    ...raw,
    event: { subscribe },
    rpc: Object.assign(
      RpcClientRuntime.make(
        (input, options) => raw.rpc.call(input).pipe(Effect.provideService(CurrentHeaders, options?.headers)),
        subscribe,
      ),
      raw.rpc,
    ),
  }
})
