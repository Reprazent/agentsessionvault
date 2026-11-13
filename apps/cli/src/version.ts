import pkg from "../package.json" with { type: "json" };

/** Clients compare this with their own to spot a daemon left over from an upgrade. */
export const VERSION: string = pkg.version;
