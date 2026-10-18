type FailureSource = "heartbeat" | "route" | "page";

/** Keep the first unexpected error from each asynchronous source through teardown. */
export class SoakFailures {
  readonly #recorded = new Map<FailureSource, Error>();

  record(source: FailureSource, cause: unknown) {
    if (!this.#recorded.has(source))
      this.#recorded.set(
        source,
        new Error(`${source}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }),
      );
  }

  assertClear() {
    if (this.#recorded.size)
      throw new AggregateError(
        [...this.#recorded.values()],
        `Unexpected wall soak failures: ${[...this.#recorded.values()].map((error) => error.message).join("; ")}`,
      );
  }
}
