export * as GlobalInstructionSource from "./global-instruction-source.js"

import { Effect } from "effect"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import type { WorkerdR2 } from "../../workerd/r2.js"

/**
 * The runtime's durable global AGENTS.md source. The default (Node/Bun)
 * runtimes have none — the local `~/.config/opencode/AGENTS.md` read inside
 * `ConfigInstructionPlugin` already serves them — so this resolves to nothing.
 * The workerd variant (resolved through the `workerd` bundle condition, like
 * `#sqlite`) reads `agents/AGENTS.md` from the bound R2 bucket.
 */
export interface Source {
  /** Reads the durable global AGENTS.md, or undefined when this runtime has none. */
  readonly read: () => Effect.Effect<InstructionDiscovery.File | undefined, never, WorkerdR2.Service>
}

export const read: Source["read"] = () => Effect.succeed(undefined)
