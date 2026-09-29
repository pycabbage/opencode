export * as EventFeed from "./event-feed"

import { Bus } from "@opencode/core/bus"
import { Event } from "@opencode/schema/event"
import { isOpenCodeEvent, type OpenCodeEvent } from "@opencode/protocol/groups/event"
import { Cause, Context, Effect, Layer, Queue, Schema, Scope, Stream } from "effect"

export const SubscriberCapacity = 4_096

export class SubscriberOverflowError extends Schema.TaggedError<SubscriberOverflowError>()(
  "EventFeed.SubscriberOverflow",
  { capacity: Schema.Int },
) {}

export class EncodingError extends Schema.TaggedError<EncodingError>()("EventFeed.EncodingError", {
  eventID: Event.ID,
  eventType: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Error = SubscriberOverflowError | EncodingError

export interface Interface {
  readonly subscribe: Effect.Effect<Stream.Stream<string, Error>, never, Scope.Scope>
  /**
   * Decoded event subscription for in-process consumers (e.g. the embedded SDK host) that read
   * `OpenCodeEvent` values directly and skip the string encoding `subscribe` performs for the
   * wire. Delivery semantics (volatile, capacity, filtering) are identical to `subscribe`.
   */
  readonly subscribeEvents: Effect.Effect<Stream.Stream<OpenCodeEvent, Error>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/EventFeed") {}

export type OnEvent = (event: OpenCodeEvent) => void

const notifyEventSinkIgnoringErrors = (onEvent: OnEvent, event: OpenCodeEvent) =>
  Effect.try({ try: () => onEvent(event), catch: (cause) => cause }).pipe(
    Effect.catch((cause) => Effect.logWarning("onEvent handler failed", { eventID: event.id, eventType: event.type, cause })),
  )

export const make = Effect.fn("EventFeed.make")(function* (
  observe: (subscriber: Bus.Subscriber) => Effect.Effect<Bus.Unsubscribe>,
  options?: {
    readonly capacity?: number
    readonly encode?: (event: OpenCodeEvent) => string
    readonly onEvent?: OnEvent
  },
) {
  const capacity = options?.capacity ?? SubscriberCapacity
  const render = options?.encode ?? JSON.stringify
  const onEvent = options?.onEvent
  const subscribers = new Set<Queue.Queue<string, Error>>()
  const eventSubscribers = new Set<Queue.Queue<OpenCodeEvent, Error>>()

  const offerOrFail = <A>(subscribers: Set<Queue.Queue<A, Error>>, value: A) => {
    for (const subscriber of subscribers) {
      if (Queue.offerUnsafe(subscriber, value)) continue
      subscribers.delete(subscriber)
      Queue.failCauseUnsafe(subscriber, Cause.fail(new SubscriberOverflowError({ capacity })))
    }
  }

  const fail = (error: Error) =>
    Effect.sync(() => {
      const current = Array.from(subscribers)
      subscribers.clear()
      for (const subscriber of current) Queue.failCauseUnsafe(subscriber, Cause.fail(error))
      const currentEvents = Array.from(eventSubscribers)
      eventSubscribers.clear()
      for (const subscriber of currentEvents) Queue.failCauseUnsafe(subscriber, Cause.fail(error))
    })

  const publish = Effect.fnUntraced(function* (event: Event.Payload) {
    if (!isOpenCodeEvent(event)) return
    if (onEvent) yield* notifyEventSinkIgnoringErrors(onEvent, event)
    offerOrFail(eventSubscribers, event)
    if (subscribers.size === 0) return
    const encoded = yield* Effect.try({
      try: () => render(event),
      catch: (cause) => new EncodingError({ eventID: event.id, eventType: event.type, cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("Failed to encode public event", {
          eventID: error.eventID,
          eventType: error.eventType,
          cause: error.cause,
        }).pipe(Effect.andThen(fail(error)), Effect.as(undefined)),
      ),
    )
    if (encoded === undefined) return
    offerOrFail(subscribers, encoded)
  })

  const unsubscribe = yield* observe(publish)
  yield* Effect.addFinalizer(() => unsubscribe)

  const subscribeTo = <A>(subscribers: Set<Queue.Queue<A, Error>>) =>
    Effect.acquireRelease(
      Queue.dropping<A, Error>(capacity).pipe(Effect.tap((queue) => Effect.sync(() => subscribers.add(queue)))),
      (queue) =>
        Effect.sync(() => subscribers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid),
    ).pipe(Effect.map(Stream.fromQueue))

  return Service.of({
    subscribe: subscribeTo(subscribers),
    subscribeEvents: subscribeTo(eventSubscribers),
  })
})

export const layer = (onEvent?: OnEvent) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      return yield* make(bus.listen, { onEvent })
    }),
  )
