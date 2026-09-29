import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { SdkEvents } from "../src/internal/events"

describe("SdkEvents.subscribe", () => {
  test("fails the subscription once its internal buffer exceeds capacity", async () => {
    const capacity = 4_096
    const overflow = Array.from({ length: capacity + 1 }, () => SdkEvents.connectedEvent())

    let fiber: Fiber.Fiber<unknown, unknown> | undefined
    const source: SdkEvents.Source = {
      runtime: {
        runFork: (effect) => {
          const result = Effect.runFork(effect)
          fiber = result
          return result
        },
      },
      events: {
        subscribe: Effect.succeed(Stream.empty),
        subscribeEvents: Effect.succeed(Stream.fromIterable(overflow)),
      },
    }

    const iterator = SdkEvents.subscribe(source)[Symbol.asyncIterator]()
    if (fiber) await Effect.runPromise(Fiber.await(fiber))

    expect(await iterator.next()).toMatchObject({ done: false, value: { type: "server.connected" } })
    for (let i = 1; i < capacity; i++) {
      expect((await iterator.next()).done).toBe(false)
    }

    const result = await iterator.next().catch((error: unknown) => error)
    expect(result).toMatchObject({ name: "ClientError", reason: "Transport" })
    expect((result as Error).message).toBe(`Transport: Event subscriber exceeded its ${capacity}-event capacity`)
  })
})
