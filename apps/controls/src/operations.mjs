import { exactKeys, requireThat } from "./store.mjs";
/** Host opt-in only; never infer a repository grant from the operator role. */
export function createOperationsManager({ operations, authorizeRepository, refreshSession }) {
  return async ({ path, method, input, respond }) => {
    const match =
      /^\/controls\/operations\/([1-9][0-9]{0,15})(?:\/(replay|replay-window(?:\/preview)?|health|replays\/([A-Za-z0-9_-]{1,128})))?$/.exec(
        path,
      );
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
    if (match[2] === "health" || match[3]) {
      requireThat(method === "GET", 405, "Method not allowed");
      const name = match[2] === "health" ? "readHealth" : "readReplayResult";
      requireThat(typeof operations[name] === "function", 503, "Observed operation results unavailable");
      let result;
      // The real adapter keeps its source/publication locks across the final
      // grant lookup and the synchronous HTTP serialization/send boundary.
      const observe = async (data, beforeSend) => {
        requireThat(typeof beforeSend === "function", 503, "Observed operation result fence unavailable");
        result = await finish(200, data);
        beforeSend();
        respond?.(result, beforeSend);
      };
      if (name === "readHealth") await operations.readHealth(repositoryId, authorize, observe);
      else await operations.readReplayResult(repositoryId, match[3], authorize, observe);
      requireThat(result, 503, "Observed operation result fence unavailable");
      return result;
    }
    if (match[2] === "replay-window/preview" || match[2] === "replay-window") {
      requireThat(method === "POST", 405, "Method not allowed");
      const preview = match[2] === "replay-window/preview";
      requireThat(
        typeof operations[preview ? "previewReplayWindow" : "replayWindow"] === "function",
        503,
        "Window replay unavailable",
      );
      exactKeys(input, [
        "receivedSince",
        "receivedUntil",
        "limit",
        "policyVersion",
        ...(preview ? [] : ["expectedRevision", "reason", "confirmed"]),
      ]);
      const window = {
        repositoryId,
        receivedSince: input.receivedSince,
        receivedUntil: input.receivedUntil,
        limit: input.limit,
        policyVersion: input.policyVersion,
      };
      if (preview) return finish(200, await operations.previewReplayWindow(window, authorize));
      requireThat(input.confirmed === true, 400, "Scoped confirmation required");
      const session = await refreshSession();
      return finish(
        201,
        await operations.replayWindow(
          {
            ...window,
            expectedRevision: input.expectedRevision,
            reason: input.reason,
            operatorId: session.actorId,
          },
          authorize,
        ),
      );
    }
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
