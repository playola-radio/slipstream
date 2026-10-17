/** Deterministic synthetic workload shapes for the auto-capture overhead bench. */

/**
 * In-scope file counts (`git ls-files -co --exclude-standard`) of the 48 non-empty
 * Conductor worktrees under ~/conductor/workspaces on 2026-10-17. Counts only; no
 * real worktree content is ever read or copied by the bench.
 */
export const REAL_WORKTREE_FILE_COUNTS: readonly number[] = [
  1, 3, 6, 8, 83, 102, 121, 121, 155, 164, 203, 205, 211, 233, 234, 235, 420, 420, 427, 626, 628, 628, 629,
  663, 728, 728, 908, 932, 971, 972, 979, 988, 995, 1050, 1051, 1635, 1658, 2343, 2494, 2526, 2545, 2552,
  2574, 2589, 2612, 2622, 2622, 2884,
];

/** mulberry32: small, seedable, good enough for workload shapes. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export function sampleWorktreeFileCounts(n: number, rng: () => number): number[] {
  return Array.from({ length: n }, () =>
    REAL_WORKTREE_FILE_COUNTS[Math.floor(rng() * REAL_WORKTREE_FILE_COUNTS.length)]!);
}

/**
 * File sizes of those same worktrees' in-scope files, from `lstat` only (50,751
 * files, mean 56,615 bytes): count per power-of-two bucket. Key b covers
 * [2^b, 2^(b+1)) bytes; key -1 is empty files.
 */
export const REAL_FILE_SIZE_LOG2_HISTOGRAM: Readonly<Record<number, number>> = {
  [-1]: 237, 2: 24, 3: 54, 4: 190, 5: 1132, 6: 1258, 7: 2044, 8: 3548, 9: 3926, 10: 6986, 11: 8697,
  12: 7347, 13: 6158, 14: 3121, 15: 1653, 16: 1746, 17: 770, 18: 1433, 19: 257, 20: 103, 21: 20,
  23: 19, 24: 14, 25: 14,
};

const SIZE_BUCKETS = Object.entries(REAL_FILE_SIZE_LOG2_HISTOGRAM).map(([b, n]) => ({ bucket: Number(b), n }));
const SIZE_TOTAL = SIZE_BUCKETS.reduce((a, b) => a + b.n, 0);

/** Pick a bucket by its real frequency, then a size uniformly inside it. */
export function sampleFileSize(rng: () => number): number {
  let pick = rng() * SIZE_TOTAL;
  let chosen = SIZE_BUCKETS[SIZE_BUCKETS.length - 1]!;
  for (const b of SIZE_BUCKETS) {
    if (pick < b.n) { chosen = b; break; }
    pick -= b.n;
  }
  if (chosen.bucket < 0) return 0;
  const lo = 2 ** chosen.bucket;
  return lo + Math.floor(rng() * lo);
}

const FILES_PER_DIR = 40;
const DIRS_PER_GROUP = 20;

/** `src/gNN/dNN/fNN.txt`: shallow, bounded directories like a real source tree. */
export function layoutPaths(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const dir = Math.floor(i / FILES_PER_DIR);
    return `src/g${Math.floor(dir / DIRS_PER_GROUP)}/d${dir % DIRS_PER_GROUP}/f${i % FILES_PER_DIR}.txt`;
  });
}
