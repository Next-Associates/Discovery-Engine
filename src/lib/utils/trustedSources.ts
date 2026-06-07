/** Official / primary publishers — prefer these over blogs, mirrors, and aggregators. */
const TRUSTED_DOMAIN_PATTERNS: RegExp[] = [
  /\.gov(\.|$)/i,
  /\.mil(\.|$)/i,
  /\.int(\.|$)/i,
  /un\.org/i,
  /imo\.org/i,
  /ilo\.org/i,
  /fao\.org/i,
  /icj-cij\.org/i,
  /marineregions\.org/i,
  /noaa\.gov/i,
  /vliz\.be/i,
  /europa\.eu/i,
  /legislation\.gov/i,
  /github\.com\/[^/]+\/[^/]+\/releases/i,
  /huggingface\.co\/(?:datasets|models)\//i,
  /zenodo\.org\/record/i,
  /data\.gov/i,
  /arcgis\.com/i,
];

const LOW_TRUST_PATTERNS: RegExp[] = [
  /pmc\.ncbi\.nlm\.nih\.gov/i,
  /researchgate\.net/i,
  /scribd\.com/i,
  /wikipedia\.org/i,
  /reddit\.com/i,
  /quora\.com/i,
];

export function getSourceTrustScore(url: string | undefined): number {
  if (!url) return 0;

  let score = 1;

  if (TRUSTED_DOMAIN_PATTERNS.some((p) => p.test(url))) {
    score += 10;
  }

  if (LOW_TRUST_PATTERNS.some((p) => p.test(url))) {
    score -= 3;
  }

  return score;
}

export function compareSourceTrust(
  a: { metadata?: { url?: string } },
  b: { metadata?: { url?: string } },
): number {
  return (
    getSourceTrustScore(b.metadata?.url) -
    getSourceTrustScore(a.metadata?.url)
  );
}

export function isTrustedSourceUrl(url: string | undefined): boolean {
  return getSourceTrustScore(url) >= 10;
}
