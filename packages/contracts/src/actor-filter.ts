import { z } from "zod";
import type { Actor } from "./v1/schemas.js";

export const actorFilterSchema = z.enum(["user", "automation", "all"]);
export type ActorFilter = z.infer<typeof actorFilterSchema>;

/** Account kind and positively known execution mode are independent dimensions. */
export function matchesActorFilter(actor: Pick<Actor, "kind" | "executionMode">, filter: ActorFilter): boolean {
  if (filter === "all") return true;
  if (filter === "user") return actor.kind === "user";
  return ["bot", "github_app", "service_account", "system"].includes(actor.kind) || actor.executionMode === "automated";
}

export const actorFilterLabels: Readonly<Record<ActorFilter, string>> = {
  all: "All activity",
  user: "User accounts",
  automation: "Automation",
};
