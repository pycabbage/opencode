import { Event } from "@opencode/schema/event"
import { EventManifest } from "@opencode/schema/event-manifest"
import { Location } from "@opencode/schema/location"
import type { Definition } from "@opencode/schema/event"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

const fields = {
  id: Event.ID,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  location: Schema.optional(Location.PublicRef),
}

const rpcEvent = Schema.Struct({
  id: Event.ID,
  created: Schema.Finite,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  type: Schema.TemplateLiteral(["rpc.", Schema.String]),
  location: Location.PublicRef,
  data: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "V2Event.rpc" })

const schema = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) =>
  Schema.Union([
    ...definitions,
    rpcEvent,
    ...(definitions.some((definition) => definition.type === "server.connected")
      ? []
      : [
          Schema.Struct({
            ...fields,
            type: Schema.Literal("server.connected"),
            data: Schema.Struct({}),
          }).annotate({ identifier: "V2Event.server.connected" }),
        ]),
  ]).annotate({ identifier: "V2Event" })

const make = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) => {
  const EventSchema = schema(definitions)
  return {
    schema: EventSchema,
    group: HttpApiGroup.make("server.event")
      .add(
        HttpApiEndpoint.get("event.subscribe", "/api/event", {
          // The Effect API client uses this stream marker for its typed event contract. The
          // OpenAPI transform below replaces the HTTP stream response with the WebSocket contract.
          success: HttpApiSchema.StreamSse({ data: EventSchema }),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "event.subscribe",
            summary: "Subscribe to events over WebSocket",
            description:
              "Receive one JSON-encoded native or plugin RPC event per WebSocket message. Events during disconnection are missed.",
            transform: (operation) => {
              const responses = { ...operation.responses }
              delete responses["200"]
              return {
                ...operation,
                "x-websocket": true,
                responses: {
                  ...responses,
                  "101": { description: "WebSocket accepted; each message contains one JSON event." },
                },
              }
            },
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "event", description: "Experimental WebSocket event subscription." })),
  }
}

export const makeEventGroup = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) =>
  make(definitions).group

const event = make(EventManifest.ServerDefinitions)
export const EventGroup = event.group
export const OpenCodeEvent = event.schema
export type OpenCodeEvent = typeof OpenCodeEvent.Type
export type OpenCodeEventEncoded = typeof OpenCodeEvent.Encoded
export const isOpenCodeEvent = (event: { readonly type: string }): event is OpenCodeEvent =>
  event.type === "server.connected" || EventManifest.isServer(event) || event.type.startsWith("rpc.")
