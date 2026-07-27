/**
 * Citation module — data contracts.
 *
 * Re-exported from their current homes rather than physically moved. The plan
 * (MM-1.1) explicitly allows "move OR re-export": establishing the boundary
 * first, with zero behavioral risk, means the frozen golden manifests keep
 * passing and the physical move becomes a later mechanical step rather than a
 * refactor that could silently change compiled output.
 *
 * Anything a consumer outside this module needs should be listed here. If a
 * type is NOT re-exported, that is the signal it is module-internal.
 */

export type { SourceIdentityRecord } from "../../lib/research/identity.js";
export type { CitationUrlVerification, VerifySourceOptions } from "../../lib/research/verify.js";
export type { CitationMarker } from "../../lib/research/citation-markers.js";
