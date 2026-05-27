export interface DecideInput {
  mentions: string[];
  author: string;
  baseRef: string;
  protectedBranches: string[];
  registeredLogins: string[];
}

export interface DecideResult {
  blocked: boolean;
  blockedBranch?: string;
  approveAs: string[];
  skippedNoPat: string[];
}

export function decide(input: DecideInput): DecideResult {
  const lc = (s: string) => s.toLowerCase();
  const author = lc(input.author);
  const base = lc(input.baseRef);
  const protectedBranches = input.protectedBranches.map(lc);
  const registered = new Set(input.registeredLogins.map(lc));

  if (protectedBranches.includes(base)) {
    return {
      blocked: true,
      blockedBranch: input.baseRef,
      approveAs: [],
      skippedNoPat: [],
    };
  }

  const candidates: string[] = [];
  for (const m of input.mentions.map(lc)) {
    if (m === author) continue;
    if (!candidates.includes(m)) candidates.push(m);
  }

  const approveAs: string[] = [];
  const skippedNoPat: string[] = [];
  for (const c of candidates) {
    if (registered.has(c)) approveAs.push(c);
    else skippedNoPat.push(c);
  }

  return { blocked: false, approveAs, skippedNoPat };
}
