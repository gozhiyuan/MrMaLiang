/**
 * Publication module (MM-1.4).
 *
 * Owns submission packaging and the publication release checks — the last gate
 * before a manuscript is declared shippable.
 *
 * ## Status
 *
 * Facade over `src/lib/publication.ts`.
 */

export type { PublicationCheck, PublicationReport } from "../../lib/publication.js";
export {
  publicationDocumentClass,
  copyPublicationTemplateAssets,
  validatePublicationWorkspace,
  packagePublicationWorkspace,
} from "../../lib/publication.js";

export const PUBLICATION_SUBCOMMANDS = {
  package: ["publication", "package"],
} as const satisfies Record<string, readonly string[]>;
