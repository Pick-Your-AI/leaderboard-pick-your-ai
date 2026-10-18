import { exactKeys, requireThat } from "./store.mjs";
/** Host opt-in only; never infer a repository grant from the operator role. */
export function createOperationsManager({ operations, authorizeRepository, refreshSession }) {
  return async ({ path, method, input }) => {
    const match = /^\/controls\/operations\/([1-9][0-9]{0,15})(?:\/(replay))?$/.exec(path);
    requireThat(match, 404, "Not found");
    const repositoryId = Number(match[1]);
    requireThat(Number.isSafeInteger(repositoryId));
    const authorize = async () => {
      const session = await refreshSession();
      requireThat(session.roles.includes("operator"), 403, "Operator role required");
      requireThat(operations && typeof authorizeRepository === "function", 503, "Operations unavailable");
      const grant = await authorizeRepository({ actorId: session.actorId, repositoryId });
      requireThat(grant?.allowed === true, 403, "Repository authorization required");
      const current = await refreshSession();
      requireThat(
        current.actorId === session.actorId && current.roles.includes("operator"),
        403,
        "Operator role required",
      );
      return { policyVersion: grant.policyVersion, revision: grant.revision };
    };
    const initialAuthority = await authorize();
    const finish = async (status, data) => {
      // The adapter and its database commit are asynchronous. Do not return
      // diagnostics or a receipt under an expired or changed authority.
      const currentAuthority = await authorize();
      requireThat(
        JSON.stringify(currentAuthority) === JSON.stringify(initialAuthority),
        409,
        "Operation authority changed; reload before retry",
      );
      return { status, data };
    };
    if (method === "GET" && !match[2]) return finish(200, await operations.read(repositoryId, authorize));
    requireThat(method === "POST" && match[2] === "replay", 405, "Method not allowed");
    exactKeys(input, ["deliveryId", "expectedRevision", "reason", "confirmed"]);
    requireThat(input.confirmed === true, 400, "Scoped confirmation required");
    const session = await refreshSession();
    return finish(
      201,
      await operations.replay(
        {
          repositoryId,
          deliveryId: input.deliveryId,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          operatorId: session.actorId,
        },
        authorize,
      ),
    );
  };
}
