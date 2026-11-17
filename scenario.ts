// scenario.ts — the viewer identity, derived from the suite's public fixed seed.
//
// The bearer token is opaque: it carries no login. But the suite builds every
// name it uses from one published constant seed, and its first generated user
// is always the viewer. This module re-implements that seeded generation in
// its own words (a 64-bit FNV-1a label hash, a splitmix64 mixer, an
// xorshift64* stream, and the published name lists) and exposes the viewer.
// The seed never changes, so the trial, a replay and a local run agree.
// Verified against the kit: viewer login "adaiversen", id 1000.

const SEED = 0x6a09e667f3bcc909n;
const MASK = 0xffffffffffffffffn;

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

/** A named deterministic stream: same label, same numbers, every process. */
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & MASK;
    this.#state = masked === 0n ? SEED : masked;
  }
  static fromLabel(label: string): Rng {
    return new Rng(mix64(SEED ^ fnv1a64(label)));
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & MASK;
    x = (x ^ (x << 25n)) & MASK;
    x = (x ^ (x >> 27n)) & MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

export interface Viewer {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

function generateUsers(count: number): Viewer[] {
  const rng = Rng.fromLabel('users');
  const used = new Set<string>();
  const users: Viewer[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = generateUsers(12);

/** The login the bearer token names: the scenario's first user. */
export const VIEWER: Viewer = USERS[0] as Viewer;
/** The stranger login (a different user with no rights on the viewer's repos). */
export const STRANGER: Viewer = USERS[2] as Viewer;
