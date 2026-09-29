export * as SdkEvents from "./events"

import { ClientError } from "@opencode/client"
import type { OpenCodeEvent } from "@opencode/client/effect"
import { Event } from "@opencode/schema/event"
import type { EventFeed } from "@opencode/server/event-feed"
import { Effect, Exit, Fiber, Stream } from "effect"

export interface RuntimeLike {
  readonly runFork: <A, E>(effect: Effect.Effect<A, E, never>) => Fiber.Fiber<A, unknown>
}

export interface Source {
  readonly runtime: RuntimeLike
  readonly events: EventFeed.Interface
}

/**
 * Mirrors the synthetic first frame `packages/server/src/handlers/event.ts` sends on every fresh
 * WebSocket upgrade. In-process subscribers get the same "you are now connected" marker so callers
 * observe one contract regardless of transport.
 */
export function connectedEvent(): OpenCodeEvent {
  return { id: Event.ID.create(), type: "server.connected", data: {} } satisfies OpenCodeEvent
}

const transportError = (detail: string) => new ClientError("Transport", { detail })

export function subscribe(
  host: Source,
  options?: { readonly signal?: AbortSignal; readonly onActivity?: () => void },
): AsyncIterable<OpenCodeEvent> {
  return {
    [Symbol.asyncIterator]() {
      type Result = IteratorResult<OpenCodeEvent>
      type Completion = { readonly error: unknown } | undefined

      const pending: Array<{ readonly resolve: (result: Result) => void; readonly reject: (error: unknown) => void }> =
        []
      const queued: OpenCodeEvent[] = []
      const capacity = 4_096
      let settled = false
      let completion: Completion
      let fiber: Fiber.Fiber<void, unknown> | undefined

      const push = (event: OpenCodeEvent) => {
        if (settled) return
        const request = pending.shift()
        if (request) {
          request.resolve({ done: false, value: event })
          return
        }
        if (queued.length === capacity) {
          finish({ error: transportError(`Event subscriber exceeded its ${capacity}-event capacity`) })
          fiber?.interruptUnsafe()
          return
        }
        queued.push(event)
      }

      const finish = (result: Completion) => {
        if (settled) return
        settled = true
        completion = result
        options?.signal?.removeEventListener("abort", onAbort)
        pending.splice(0).forEach((request) => {
          if (result) request.reject(result.error)
          else request.resolve({ done: true, value: undefined })
        })
      }

      fiber = host.runtime.runFork(
        Effect.scoped(
          Effect.gen(function* () {
            const live = yield* host.events.subscribeEvents
            yield* Stream.make(connectedEvent())
              .pipe(Stream.concat(live))
              .pipe(
                Stream.runForEach((event) =>
                  Effect.sync(() => {
                    push(event)
                    options?.onActivity?.()
                  }),
                ),
              )
          }),
        ),
      )

      fiber.addObserver((exit) =>
        finish(Exit.isSuccess(exit) ? undefined : { error: transportError("Event stream ended") }),
      )

      const onAbort = () => {
        finish({ error: transportError("Event subscription aborted") })
        fiber.interruptUnsafe()
      }
      if (options?.signal?.aborted) onAbort()
      else options?.signal?.addEventListener("abort", onAbort, { once: true })

      return {
        next(): Promise<Result> {
          const value = queued.shift()
          if (value !== undefined) return Promise.resolve({ done: false, value })
          if (settled) return completion ? Promise.reject(completion.error) : Promise.resolve({ done: true, value: undefined })
          return new Promise<Result>((resolve, reject) => pending.push({ resolve, reject }))
        },
        return(): Promise<Result> {
          finish(undefined)
          fiber.interruptUnsafe()
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}
