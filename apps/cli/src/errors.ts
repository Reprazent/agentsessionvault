// Errors shared by the service and live pull.

/** Pulling into a file a harness has open would race its writes. */
export class SessionOpenError extends Error {
  constructor(readonly path: string) {
    super(`that session is open in a harness; close it (or switch to another session) and pull again`);
    this.name = "SessionOpenError";
  }
}
