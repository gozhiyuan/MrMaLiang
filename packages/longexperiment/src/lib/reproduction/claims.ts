import { ReproductionClaim } from "@mr-maliang/research-protocol";
export function reconcileClaims(paperText: string, candidates: unknown[]): Array<ReturnType<typeof ReproductionClaim.parse>> {
  return candidates.map((candidate) => ReproductionClaim.parse(candidate)).filter((claim) => {
    if (!paperText.includes(claim.anchor.quote)) throw new Error("claim " + claim.id + " anchor quote is absent from the selected paper");
    return true;
  });
}
