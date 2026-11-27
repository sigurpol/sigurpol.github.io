// Chain reads and checks for staking-monitor.html. No DOM code, so Node can run it for
// cross-checks. Staking lives on Asset Hub (staking-async, election-provider-multi-block). The
// relay chain gives the session and the validator set handoff.
import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";

export const NETWORKS = {
  polkadot: {
    label: "Polkadot",
    subscan: "https://assethub-polkadot.subscan.io",
    ah: { name: "Asset Hub", url: "wss://polkadot-asset-hub-rpc.polkadot.io" },
    relay: { name: "Relay chain", url: "wss://rpc.polkadot.io" },
    // HARD_CAP_TARGET in the Polkadot Asset Hub runtime (Referendum 1710), in whole DOT.
    hardCap: 2_100_000_000n,
    // Era length the runtime's Inflation API assumes for `next_mint`.
    inflationEraMs: 86_400_000,
  },
  kusama: {
    label: "Kusama",
    subscan: "https://assethub-kusama.subscan.io",
    ah: { name: "Asset Hub", url: "wss://kusama-asset-hub-rpc.polkadot.io" },
    relay: { name: "Relay chain", url: "wss://kusama-rpc.polkadot.io" },
    inflationEraMs: 21_600_000,
  },
  westend: {
    label: "Westend",
    subscan: "https://assethub-westend.subscan.io",
    ah: { name: "Asset Hub", url: "wss://westend-asset-hub-rpc.polkadot.io" },
    relay: { name: "Relay chain", url: "wss://westend-rpc.polkadot.io" },
    // `IssuanceCurve` of the Westend Asset Hub runtime: 8% a year of a fixed total issuance.
    issuanceCurve: { fixedTotalIssuance: 5_216_342_402_773_185_773n, percent: 8n },
  },
};

const RPC_TIMEOUT = 30_000;
// Staking.RewardPots rotates era pots over `era % POT_POOL_SIZE` (staking-async lib.rs).
const POT_POOL_SIZE = 200;
// Asset Hub activates an era a little after the relay activation timestamp in ActiveEra.start.
const ERA_TOLERANCE = 300_000;
// `MILLISECONDS_PER_YEAR` of the runtime issuance curves.
const YEAR_MS = 31_557_600_000;
// Claimed pages change all the time but are costly to read, so they are re-read at most this often.
const CLAIMS_TTL = 300_000;
const PHASE_RANK = { Off: 0, Snapshot: 1, Signed: 2, SignedValidation: 3, Unsigned: 4, Done: 5, Export: 6 };
const ROUND_PHASES = ["Snapshot", "Signed", "SignedValidation", "Unsigned", "Done", "Export"];
const ELECTION_EVENTS = new Set(["MultiBlockElectionSigned", "MultiBlockElectionVerifier", "MultiBlockElection"]);

const withTimeout = (p, what) =>
  Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), RPC_TIMEOUT)),
  ]);
const errText = (e) => String(e?.message ?? e);
const text = (bytes) => new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : Uint8Array.from(Object.values(bytes)));

// `PalletId(id).into_sub_account_truncating(sub)`: "modl" ++ id ++ SCALE(sub), zero padded to 32 bytes.
function palletAccount(id, sub, ss58) {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode("modl"));
  out.set(new TextEncoder().encode(id), 4);
  out.set(sub, 12);
  return AccountId(ss58).dec(out);
}
// `RewardPot::Era(era % POT_POOL_SIZE, RewardKind::StakerRewards)` under `py/stkng`.
const eraPotAccount = (era, ss58) => {
  const slot = era % POT_POOL_SIZE;
  return palletAccount("py/stkng", [1, slot & 255, (slot >> 8) & 255, 0, 0, 0], ss58);
};

// First n in [lo, hi] with pred(n) true, for a monotone pred. Returns hi when none is.
async function firstTrue(lo, hi, pred) {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

class Chain {
  constructor(def) {
    this.def = def;
    this.client = createClient(getWsProvider(def.url));
    this.api = this.client.getUnsafeApi();
    this.hashes = new Map();
    this.stamps = new Map();
    this.items = null;
    this.msPerBlock = null;
  }

  async head() {
    const [best] = await withTimeout(this.client.getBestBlocks(), `${this.def.name} best block`);
    this.best = best;
    if (!this.items) {
      const md = unifyMetadata(decAnyMetadata(await withTimeout(this.client.getMetadata(best.hash), "metadata")));
      this.items = new Set([
        ...md.pallets.flatMap((p) => [
          p.name,
          ...(p.storage?.items ?? []).map((i) => `${p.name}.${i.name}`),
          ...p.constants.map((c) => `${p.name}.${c.name}`),
        ]),
        ...md.apis.map((a) => `api:${a.name}`),
      ]);
      this.props = await withTimeout(this.client._request("system_properties", []), "system_properties");
    }
    return best;
  }

  has(path) {
    return this.items.has(path);
  }

  // Storage at the best block, or `undefined` when the item is not in this runtime.
  async q(path, ...args) {
    return this.read(this.best.hash, path, args);
  }

  // Storage at block number `n`.
  async qAt(n, path, ...args) {
    return this.read(await this.hash(n), path, args);
  }

  async read(at, path, args) {
    if (!this.has(path)) return undefined;
    const [pallet, item] = path.split(".");
    return withTimeout(this.api.query[pallet][item].getValue(...args, { at }), path);
  }

  async entries(path, ...args) {
    if (!this.has(path)) return undefined;
    const [pallet, item] = path.split(".");
    return withTimeout(this.api.query[pallet][item].getEntries(...args, { at: this.best.hash }), path);
  }

  async constant(path) {
    if (!this.has(path)) return undefined;
    const [pallet, item] = path.split(".");
    return this.api.constants[pallet][item]({ at: this.best.hash });
  }

  async hash(n) {
    if (!this.hashes.has(n)) {
      const p = withTimeout(this.client._request("chain_getBlockHash", [n]), `hash #${n}`).then((h) => {
        if (!h) throw new Error(`no block #${n}`);
        return h;
      });
      p.catch(() => this.hashes.delete(n));
      this.hashes.set(n, p);
    }
    return this.hashes.get(n);
  }

  async timestamp(n) {
    if (!this.stamps.has(n)) {
      const p = this.qAt(n, "Timestamp.Now").then(Number);
      p.catch(() => this.stamps.delete(n));
      this.stamps.set(n, p);
    }
    return this.stamps.get(n);
  }

  async events(n, pallets) {
    const evs = await this.qAt(n, "System.Events");
    return evs
      .map(({ event }) => ({ n, pallet: event.type, name: event.value.type, value: event.value.value }))
      .filter((e) => !pallets || pallets.has(e.pallet));
  }

  async blockTime() {
    if (this.msPerBlock === null) {
      const best = this.best.number;
      this.msPerBlock = ((await this.timestamp(best)) - (await this.timestamp(best - 1000))) / 1000;
    }
    return this.msPerBlock;
  }

  // First block whose timestamp is at least `ts`, or best + 1 when none is yet.
  async firstBlockAtOrAfter(ts) {
    const best = this.best.number;
    if ((await this.timestamp(best)) < ts) return best + 1;
    const guess = best - Math.round(((await this.timestamp(best)) - ts) / (await this.blockTime()));
    let lo = Math.max(guess - 20, 1);
    let hi = Math.min(guess + 20, best);
    while ((await this.timestamp(lo)) > ts) lo = Math.max(lo - 500, 1);
    while (hi < best && (await this.timestamp(hi)) < ts) hi = Math.min(hi + 500, best);
    return firstTrue(lo, hi, async (n) => (await this.timestamp(n)) >= ts);
  }

  destroy() {
    this.client.destroy();
  }
}

export class Monitor {
  constructor(networkKey) {
    this.network = NETWORKS[networkKey];
    this.ah = new Chain(this.network.ah);
    this.relay = new Chain(this.network.relay);
    // Immutable history, by era or round.
    this.cache = new Map();
  }

  destroy() {
    this.ah.destroy();
    this.relay.destroy();
  }

  cached(key, fn, ttl) {
    const hit = this.cache.get(key);
    if (hit && (!ttl || Date.now() - hit.at < ttl)) return hit.p;
    const p = fn();
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, { p, at: Date.now() });
    return p;
  }

  async refresh({ eras = 4 } = {}) {
    const relayHead = this.relay.head();
    relayHead.catch(() => {});
    await this.ah.head();
    const ah = this.ah;
    const token = {
      decimals: Number([ah.props.tokenDecimals].flat()[0]),
      symbol: String([ah.props.tokenSymbol].flat()[0]),
      ss58: Number(ah.props.ss58Format ?? 42),
    };
    const safe = (p) => p.catch((e) => ({ error: errText(e) }));
    const era = await this.readEra();
    const relay = await safe(relayHead.then(() => this.readRelay(era)));
    const [election, lastRound, change, rewards, issuance] = await Promise.all([
      safe(this.readElection()),
      safe(this.readLastRound()),
      safe(this.readEraChange(era.active, era.start)),
      safe(this.readRewards(era, eras, token)),
      safe(ah.has("Dap") ? this.readDap(era, token) : this.readLegacyPayout(era)),
    ]);
    const snap = { network: this.network.label, at: Date.now(), token, era, relay, election, lastRound, change, rewards, issuance };
    snap.checks = checks(snap);
    return snap;
  }

  async readEra() {
    const ah = this.ah;
    const q = (p, ...a) => ah.q(p, ...a);
    const active = await q("Staking.ActiveEra");
    const a = active.index;
    const [
      planned, force, validatorCount, bonded, validators, nominators, minActive, minNom, minVal,
      nextElectionPage, electable, totalStake, points, outgoing, lastReport, sessionsPerEra,
      historyDepth, planningOffset, disableMinting, bestTs, overview,
    ] = await Promise.all([
      q("Staking.CurrentEra"), q("Staking.ForceEra"), q("Staking.ValidatorCount"), q("Staking.BondedEras"),
      q("Staking.CounterForValidators"), q("Staking.CounterForNominators"), q("Staking.MinimumActiveStake"),
      q("Staking.MinNominatorBond"), q("Staking.MinValidatorBond"), q("Staking.NextElectionPage"),
      q("Staking.ElectableStashes"), q("Staking.ErasTotalStake", a), q("Staking.ErasRewardPoints", a),
      q("StakingRcClient.OutgoingValidatorSet"), q("StakingRcClient.LastSessionReportEndingIndex"),
      ah.constant("Staking.SessionsPerEra"), ah.constant("Staking.HistoryDepth"),
      ah.constant("Staking.PlanningEraOffset"), ah.constant("Staking.DisableMinting"),
      ah.timestamp(ah.best.number), ah.entries("Staking.ErasStakersOverview", a),
    ]);
    return {
      best: ah.best.number,
      bestTs,
      active: a,
      start: Number(active.start),
      planned,
      force: force?.type,
      validatorCount,
      bonded,
      startSession: bonded.find(([e]) => e === a)?.[1],
      counters: { validators, nominators },
      minActive, minNom, minVal,
      nextElectionPage,
      electable: electable?.length,
      totalStake,
      points: { total: points?.total ?? 0, count: points?.individual?.length ?? 0 },
      elected: overview?.length,
      ownStake: overview?.reduce((s, e) => s + e.value.own, 0n),
      outgoing: outgoing ? { id: outgoing[0].id, count: outgoing[0].new_validator_set.length, retries: outgoing[1] } : undefined,
      lastReport,
      sessionsPerEra,
      historyDepth,
      planningOffset,
      disableMinting,
      totalIssuance: await q("Balances.TotalIssuance"),
    };
  }

  async readRelay(era) {
    const r = this.relay;
    const q = (p, ...a) => r.q(p, ...a);
    const [session, validators, epochIndex, slot, genesisSlot, epochDuration, blockTime, mode, set, nextChanges, appliedAt, bestTs] =
      await Promise.all([
        q("Session.CurrentIndex"), q("Session.Validators"), q("Babe.EpochIndex"), q("Babe.CurrentSlot"),
        q("Babe.GenesisSlot"), r.constant("Babe.EpochDuration"), r.constant("Babe.ExpectedBlockTime"),
        q("StakingAhClient.Mode"), q("StakingAhClient.ValidatorSet"), q("StakingAhClient.NextSessionChangesValidators"),
        q("StakingAhClient.ValidatorSetAppliedAt"), r.timestamp(r.best.number),
      ]);
    // pallet-babe: current epoch start slot = GenesisSlot + EpochIndex * EpochDuration.
    const sessionSlots = Number(epochDuration);
    const slotInSession = Number(slot - genesisSlot - epochIndex * epochDuration);
    return {
      best: r.best.number,
      bestTs,
      session,
      validators: validators.length,
      sessionMs: sessionSlots * Number(blockTime),
      slotInSession,
      sessionSlots,
      mode: mode?.type,
      set: set ? { id: set[0], count: set[1].length } : undefined,
      nextChanges,
      appliedAt,
      sessionInEra: era.startSession !== undefined ? session - era.startSession : undefined,
    };
  }

  async readElection() {
    const ah = this.ah;
    const q = (p, ...a) => ah.q(p, ...a);
    const round = await q("MultiBlockElection.Round");
    const [phase, desired, minimum, status, queued, sorted, invulnerables, unpaid, voterPages, targets, pages, signed, signedValidation, unsigned] =
      await Promise.all([
        q("MultiBlockElection.CurrentPhase"), q("MultiBlockElection.DesiredTargets", round),
        q("MultiBlockElectionVerifier.MinimumScore"), q("MultiBlockElectionVerifier.StatusStorage"),
        q("MultiBlockElectionVerifier.QueuedSolutionScore", round), q("MultiBlockElectionSigned.SortedScores", round),
        q("MultiBlockElectionSigned.Invulnerables"), q("MultiBlockElectionSigned.UnpaidRewards"),
        ah.entries("MultiBlockElection.PagedVoterSnapshotHash", round), ah.entries("MultiBlockElection.PagedTargetSnapshot", round),
        ah.constant("MultiBlockElection.Pages"), ah.constant("MultiBlockElection.SignedPhase"),
        ah.constant("MultiBlockElection.SignedValidationPhase"), ah.constant("MultiBlockElection.UnsignedPhase"),
      ]);
    const submissions = await Promise.all(
      [...(sorted ?? [])].reverse().map(async ([who, score]) => {
        const meta = await q("MultiBlockElectionSigned.SubmissionMetadataStorage", round, who);
        return { who, score, deposit: meta?.deposit, pagesIn: meta?.pages.filter(Boolean).length };
      }),
    );
    return {
      round,
      phase: { type: phase.type, value: phase.value },
      desired,
      minimum,
      status: status?.type === "Ongoing" ? `Ongoing(${status.value})` : status?.type,
      queued,
      submissions,
      invulnerables: invulnerables ?? [],
      unpaid: unpaid ?? [],
      voterPages: voterPages?.length ?? 0,
      targets: targets?.reduce((s, e) => s + e.value.length, 0) ?? 0,
      config: { pages, signed, signedValidation, unsigned },
      msPerBlock: await ah.blockTime(),
    };
  }

  // The last completed round, located by binary search on `Round` and `CurrentPhase` at past blocks.
  async readLastRound() {
    const round = (await this.ah.q("MultiBlockElection.Round")) - 1;
    return this.cached(`round:${round}`, () => this.readRound(round));
  }

  async readRound(round) {
    const ah = this.ah;
    const best = ah.best.number;
    const state = async (n) => {
      const [r, p] = await Promise.all([ah.qAt(n, "MultiBlockElection.Round"), ah.qAt(n, "MultiBlockElection.CurrentPhase")]);
      return { r, rank: PHASE_RANK[p.type] ?? 7 };
    };
    const span = Math.ceil(86_400_000 / (await ah.blockTime()));
    const atLeast = (rank) => async (n) => {
      const s = await state(n);
      return s.r > round || s.rank >= rank;
    };
    let lo = Math.max(best - span, 1);
    while (lo > 1 && (await atLeast(1)(lo))) lo = Math.max(lo - span, 1);
    const end = await firstTrue(lo, best, async (n) => (await state(n)).r > round);
    const start = await firstTrue(lo, end, atLeast(1));
    const blocks = { Snapshot: start };
    for (const ph of ROUND_PHASES.slice(1)) blocks[ph] = await firstTrue(start, end, atLeast(PHASE_RANK[ph]));
    blocks.Off = end;
    const stamps = Object.fromEntries(await Promise.all(Object.entries(blocks).map(async ([k, n]) => [k, await ah.timestamp(n)])));

    const sv = blocks.SignedValidation;
    const sorted = (await ah.qAt(sv - 1, "MultiBlockElectionSigned.SortedScores", round)) ?? [];
    const metas = await Promise.all(sorted.map(([who]) => ah.qAt(sv - 1, "MultiBlockElectionSigned.SubmissionMetadataStorage", round, who)));
    const [queued, desired, minimum] = await Promise.all([
      ah.qAt(end - 1, "MultiBlockElectionVerifier.QueuedSolutionScore", round),
      ah.qAt(end - 1, "MultiBlockElection.DesiredTargets", round),
      ah.qAt(end - 1, "MultiBlockElectionVerifier.MinimumScore"),
    ]);
    const queuedAt = queued
      ? await firstTrue(sv, end - 1, async (n) => (await ah.qAt(n, "MultiBlockElectionVerifier.QueuedSolutionScore", round)) !== undefined)
      : undefined;
    const signedWin = queuedAt !== undefined && queuedAt < blocks.Unsigned;
    // Each verified submission leaves SortedScores: the rejected ones first, then the winner.
    const scoresLen = async (n) => ((await ah.qAt(n, "MultiBlockElectionSigned.SortedScores", round)) ?? []).length;
    const lastSigned = Math.min(signedWin ? queuedAt : blocks.Unsigned, end - 1);
    const verified = sorted.length - (await scoresLen(lastSigned));
    const rejected = Math.max(verified - (signedWin ? 1 : 0), 0);
    const eventBlocks = [];
    for (let k = 1; k <= rejected; k++) {
      eventBlocks.push(await firstTrue(sv, lastSigned, async (n) => (await scoresLen(n)) <= sorted.length - k));
    }
    if (queuedAt !== undefined) eventBlocks.push(queuedAt);
    const events = (await Promise.all(eventBlocks.map((n) => ah.events(n, ELECTION_EVENTS)))).flat();
    const outcome = (who) => {
      const key = String(who);
      const e = events.find((x) => ["Rewarded", "Slashed", "RewardPaymentDeferred"].includes(x.name) && String(x.value?.[1]) === key);
      return e ? { name: e.name, amount: e.value[2], n: e.n } : undefined;
    };
    const submissions = [...sorted].reverse().map(([who, score], i) => {
      const meta = metas[sorted.length - 1 - i];
      return { who, score, pagesIn: meta?.pages.filter(Boolean).length, outcome: outcome(who) };
    });
    return {
      round,
      blocks,
      stamps,
      submissions,
      queued,
      queuedAt,
      source: queuedAt === undefined ? "none" : signedWin ? "signed" : "unsigned",
      rejected,
      desired,
      minimum,
      events: events.filter((e) => e.pallet !== "MultiBlockElection"),
    };
  }

  // The block where `era` became active (ActiveEra.start is the relay activation timestamp, the
  // Asset Hub block follows it), with the events there and the state just before it.
  async readEraChange(era, startTs) {
    return this.cached(`change:${era}`, async () => {
      const ah = this.ah;
      const best = ah.best.number;
      const isActive = async (n) => (await ah.qAt(n, "Staking.ActiveEra")).index >= era;
      const guess = Math.min(await ah.firstBlockAtOrAfter(startTs), best);
      let lo = Math.max(guess - 20, 1);
      while (lo > 1 && (await isActive(lo))) lo = Math.max(lo - 500, 1);
      let hi = Math.min(guess + 300, best);
      while (hi < best && !(await isActive(hi))) hi = Math.min(hi + 1000, best);
      const n = await firstTrue(lo, hi, isActive);
      const [prev, events, ts] = await Promise.all([
        ah.qAt(n - 1, "Staking.ActiveEra"),
        ah.events(n, new Set(["Staking", "StakingRcClient"])),
        ah.timestamp(n),
      ]);
      return { era, n, ts, prev: { index: prev.index, start: Number(prev.start) }, events };
    });
  }

  async readRewards(era, count, token) {
    const ah = this.ah;
    // payout_stakers accepts eras down to CurrentEra - HistoryDepth.
    const oldest = era.planned - era.historyDepth;
    const list = [...Array.from({ length: count }, (_, i) => era.active - 1 - i), oldest].filter(
      (e, i, all) => e >= 0 && all.indexOf(e) === i,
    );
    const sessions = new Map(era.bonded.map(([e, s], i, all) => [e, all[i + 1] ? all[i + 1][1] - s : undefined]));
    const rows = await Promise.all(
      list.map(async (e) => {
        const fixed = await this.cached(`era:${e}`, async () => {
          const [points, reward, budget, stake, overview] = await Promise.all([
            ah.q("Staking.ErasRewardPoints", e), ah.q("Staking.ErasValidatorReward", e),
            ah.q("Staking.ErasValidatorIncentiveBudget", e), ah.q("Staking.ErasTotalStake", e),
            ah.entries("Staking.ErasStakersOverview", e),
          ]);
          return {
            points: points?.total ?? 0,
            reward,
            budget,
            stake,
            validators: overview?.length ?? 0,
            pageCounts: new Map((overview ?? []).map((x) => [x.keyArgs[1], x.value.page_count])),
          };
        });
        const live = await this.cached(`claims:${e}`, async () => {
          const claimed = new Map(((await ah.entries("Staking.ClaimedRewards", e)) ?? []).map((x) => [x.keyArgs[1], x.value]));
          const pot = era.disableMinting ? (await ah.q("System.Account", eraPotAccount(e, token.ss58))).data.free : undefined;
          // Pages of each exposed validator not in its ClaimedRewards entry.
          const unclaimed = [...fixed.pageCounts].reduce(
            (s, [who, count]) => s + count - new Set((claimed.get(who) ?? []).filter((p) => p < count)).size,
            0,
          );
          return { unclaimed, pot };
        }, CLAIMS_TTL);
        const pages = [...fixed.pageCounts.values()].reduce((s, c) => s + c, 0);
        const { pageCounts, ...rest } = fixed;
        return { era: e, sessions: sessions.get(e), ...rest, pages, ...live };
      }),
    );
    return { rows, oldest };
  }

  async readDap(era, token) {
    const ah = this.ah;
    const [recipients, staging, cadence, maxElapsed, lastDrip, inactive, ed] = await Promise.all([
      ah.api.view.Dap.budget_recipients({ at: ah.best.hash }), ah.api.view.Dap.staging({ at: ah.best.hash }),
      ah.constant("Dap.IssuanceCadence"), ah.constant("Dap.MaxElapsedPerDrip"), ah.q("Dap.LastIssuanceTimestamp"),
      ah.q("Balances.InactiveIssuance"), ah.constant("Balances.ExistentialDeposit"),
    ]);
    const pots = recipients.map(([key, account, share]) => ({ key: text(key), account, share }));
    const free = async (who, n) => (await (n === undefined ? ah.q("System.Account", who) : ah.qAt(n, "System.Account", who))).data.free;
    const buffer = pots.find((p) => p.key === "buffer");
    for (const p of pots) p.balance = await free(p.account);
    const stagingBalance = await free(staging);
    // Buffer plus staging at the era change blocks: inflows over the last full era.
    const change = await this.readEraChange(era.active, era.start);
    const prevChange = await this.readEraChange(change.prev.index, change.prev.start);
    const reserve = async (n) => (await free(buffer.account, n)) + (await free(staging, n));
    const [reserveNow, reserveAt, reservePrev, tiAt, tiPrev, dripAt, dripPrev, round] = await Promise.all([
      Promise.resolve(buffer.balance + stagingBalance), reserve(change.n), reserve(prevChange.n),
      ah.qAt(change.n, "Balances.TotalIssuance"), ah.qAt(prevChange.n, "Balances.TotalIssuance"),
      ah.qAt(change.n, "Dap.LastIssuanceTimestamp"), ah.qAt(prevChange.n, "Dap.LastIssuanceTimestamp"),
      ah.qAt(prevChange.n, "MultiBlockElection.Round"),
    ]);
    // The election of this round ran in the last era. Its signed rewards are paid from the buffer.
    const minerRewards = await this.cached(`round:${round}`, () => this.readRound(round))
      .then((r) => (r.queuedAt > prevChange.n && r.queuedAt <= change.n ? r.events : []))
      .then((evs) => evs.filter((e) => e.name === "Rewarded").reduce((t, e) => t + e.value[2], 0n))
      .catch(() => undefined);
    const lastEra = change.prev.index;
    const [reward, budget] = await Promise.all([ah.q("Staking.ErasValidatorReward", lastEra), ah.q("Staking.ErasValidatorIncentiveBudget", lastEra)]);
    const inflation = ah.has("api:Inflation") ? await ah.api.apis.Inflation.experimental_issuance_prediction_info({ at: ah.best.hash }) : undefined;
    const cap = this.network.hardCap !== undefined ? this.network.hardCap * 10n ** BigInt(token.decimals) : undefined;
    return {
      kind: "dap",
      pots,
      staging,
      stagingBalance,
      ed,
      cadence: Number(cadence),
      maxElapsed: Number(maxElapsed),
      lastDrip: Number(lastDrip),
      totalIssuance: era.totalIssuance,
      inactive,
      inflation,
      inflationEraMs: this.network.inflationEraMs,
      curve: this.network.issuanceCurve,
      cap,
      lastEra: {
        era: lastEra,
        from: prevChange.n,
        to: change.n,
        ms: change.prev.start && era.start ? era.start - change.prev.start : undefined,
        reward,
        budget,
        reserveDelta: reserveAt - reservePrev,
        tiDelta: tiAt - tiPrev,
        dripMs: Number(dripAt - dripPrev),
        minerRewards,
      },
      thisEra: { reserveDelta: reserveNow - reserveAt, elapsed: era.bestTs - era.start },
    };
  }

  async readLegacyPayout(era) {
    const ah = this.ah;
    const change = await this.readEraChange(era.active, era.start);
    const paid = change.events.find((e) => e.name === "EraPaid");
    const [inflation, maxEraDuration, maxStaked, reward, tiBefore] = await Promise.all([
      ah.has("api:Inflation") ? ah.api.apis.Inflation.experimental_issuance_prediction_info({ at: ah.best.hash }) : undefined,
      ah.constant("Staking.MaxEraDuration"), ah.q("Staking.MaxStakedRewards"), ah.q("Staking.ErasValidatorReward", change.prev.index),
      ah.qAt(change.n - 1, "Balances.TotalIssuance"),
    ]);
    return {
      kind: "legacy",
      inflation,
      maxEraDuration: Number(maxEraDuration),
      maxStaked,
      lastEra: { era: change.prev.index, ms: era.start - change.prev.start, paid: paid?.value, reward, tiBefore },
      inflationEraMs: this.network.inflationEraMs,
      totalIssuance: era.totalIssuance,
    };
  }
}

// Checks as { status, label, value }. Status: ok, warn, bad, na.
export function checks(s) {
  const out = [];
  const add = (status, label, value) => out.push({ status, label, value });
  const { era, relay, election: el, lastRound: lr, issuance: is } = s;
  const now = s.at;

  const ahAge = (now - era.bestTs) / 1000;
  add(ahAge < 60 ? "ok" : ahAge < 180 ? "warn" : "bad", "Asset Hub best block", `#${era.best}, ${fmtAge(ahAge)} ago`);
  if (relay.error) add("bad", "Relay chain", relay.error);
  else {
    const age = (now - relay.bestTs) / 1000;
    add(age < 60 ? "ok" : age < 180 ? "warn" : "bad", "Relay chain best block", `#${relay.best}, ${fmtAge(age)} ago`);
  }

  if (!relay.error) {
    const expected = era.sessionsPerEra * relay.sessionMs;
    const age = now - era.start;
    const status = age <= expected + ERA_TOLERANCE ? "ok" : age <= expected + relay.sessionMs ? "warn" : "bad";
    add(status, "Active era", `${era.active}, ${fmtAge(age / 1000)} of ${fmtAge(expected / 1000)}, session ${relay.sessionInEra + 1} of ${era.sessionsPerEra}`);

    const planSession = era.sessionsPerEra - Math.min(era.planningOffset, era.sessionsPerEra);
    // The election starts at the planning session. Blocks it takes: both snapshots, the signed,
    // signed validation and unsigned phases.
    const k = el.config;
    const electionMs = el.error ? undefined : (2 * k.pages + k.signed + k.signedValidation + k.unsigned) * el.msPerBlock;
    if (era.planned > era.active) {
      const stage = nextSetStage(s);
      const running = now - (era.start + planSession * relay.sessionMs);
      const late = electionMs && running > 2 * electionMs && /^(election|Staking\.NextElectionPage)/.test(stage);
      add(late ? "warn" : "ok", "Planned era", `${era.planned}, ${stage}${late ? `, ${fmtAge(running / 1000)} since planning` : ""}`);
    }
    else add(plannedNoneStatus(s, planSession, electionMs), "Planned era", "none");

    const lastSession = relay.sessionInEra >= era.sessionsPerEra - 1;
    if (lastSession && era.planned > era.active && relay.nextChanges !== era.planned) {
      add("bad", "StakingAhClient.NextSessionChangesValidators", `${relay.nextChanges ?? "none"}, planned era ${era.planned}`);
    }
    const sessionAge = (relay.slotInSession / relay.sessionSlots) * relay.sessionMs;
    if (era.lastReport !== relay.session - 1) {
      add(sessionAge > 120_000 ? "warn" : "na", "LastSessionReportEndingIndex", `${era.lastReport}, relay session ${relay.session}`);
    }
    if (era.elected !== undefined && relay.validators !== era.elected) {
      add("warn", "Relay Session.Validators", `${relay.validators}, elected for era ${era.active}: ${era.elected}`);
    }
  }
  if (era.outgoing && era.planned === era.active) add("warn", "StakingRcClient.OutgoingValidatorSet", `id ${era.outgoing.id}`);

  if (!s.change.error && !relay.error) {
    const ms = era.start - s.change.prev.start;
    const expected = era.sessionsPerEra * relay.sessionMs;
    add(Math.abs(ms - expected) <= relay.sessionMs ? "ok" : "warn", `Era ${s.change.prev.index} length`, fmtAge(ms / 1000));
  }

  if (el.error) add("bad", "Election", el.error);
  else {
    add(el.phase.type === "Emergency" ? "bad" : "ok", "Election phase", `${phaseText(el.phase)}, round ${el.round}`);
    if (el.unpaid.length) add("warn", "MultiBlockElectionSigned.UnpaidRewards", String(el.unpaid.length));
  }
  if (lr.error) add("warn", "Last election round", lr.error);
  else {
    const label = `Round ${lr.round} solution`;
    if (lr.source === "none") add("bad", label, "none queued");
    else add(lr.source === "unsigned" ? "warn" : "ok", label, `${lr.source}, ${lr.submissions.length} signed submissions`);
    if (lr.rejected) add("warn", `Round ${lr.round} rejected submissions`, String(lr.rejected));
  }

  if (!s.rewards.error) {
    const last = s.rewards.rows.find((r) => r.era === era.active - 1);
    if (last) add(last.reward ? "ok" : "bad", `ErasValidatorReward ${last.era}`, last.reward ? "set" : "0");
  }
  // Points arrive with the session report at the end of the era's first session.
  const pointsDue = relay.error ? undefined : era.start + relay.sessionMs + ERA_TOLERANCE;
  add(era.points.total ? "ok" : pointsDue && now > pointsDue ? "warn" : "na", `ErasRewardPoints ${era.active}`, `${era.points.total}`);

  const score = scoreCheck(el, lr);
  if (score) add(...score);

  if (is.error) add("warn", "Issuance", is.error);
  else if (is.kind === "dap") {
    const age = (now - is.lastDrip) / 1000;
    add(age * 1000 <= is.cadence * 3 ? "ok" : "warn", "Dap.LastIssuanceTimestamp", `${fmtAge(age)} ago`);
    dapIssuanceCheck(is, s.token).forEach((c) => add(...c));
  } else legacyPayoutCheck(is, s.token).forEach((c) => add(...c));
  return out;
}

// No era planned. Problem once the election, started now, would end after the start of the era's
// last session: the relay chain takes the next validator set at that session change.
function plannedNoneStatus({ era, relay, at }, planSession, electionMs) {
  if (era.force === "ForceNone") return "na";
  const ahSession = era.lastReport + 1 - era.startSession;
  if (ahSession < planSession) return "na";
  const lastSessionStart = era.start + (era.sessionsPerEra - 1) * relay.sessionMs;
  return electionMs !== undefined && at + electionMs > lastSessionStart ? "bad" : "warn";
}

// `ElectionScore::strict_better` with a zero threshold, as the verifier compares a solution with
// MinimumScore: higher minimal_stake, then higher sum_stake, then lower sum_stake_squared.
export function strictBetter(a, b) {
  if (a.minimal_stake !== b.minimal_stake) return a.minimal_stake > b.minimal_stake;
  if (a.sum_stake !== b.sum_stake) return a.sum_stake > b.sum_stake;
  return a.sum_stake_squared < b.sum_stake_squared;
}

function scoreCheck(el, lr) {
  const [round, queued, minimum] = !el.error && el.queued ? [el.round, el.queued, el.minimum]
    : !lr.error && lr.queued ? [lr.round, lr.queued, lr.minimum] : [];
  if (!queued) return undefined;
  const label = `Round ${round} QueuedSolutionScore`;
  if (!minimum) return ["na", label, "no MinimumScore"];
  return strictBetter(queued, minimum) ? ["ok", label, "above MinimumScore"] : ["bad", label, "not above MinimumScore"];
}

const amount = (planck, token) => `${(Number(planck) / 10 ** token.decimals).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${token.symbol}`;

// ok within `tol` of `expected`, bad when zero or below half or above double, warn otherwise.
export function compare(actual, expected, tol) {
  if (actual <= 0 || actual < expected / 2 || actual > expected * 2) return "bad";
  return Math.abs(actual - expected) <= tol ? "ok" : "warn";
}

const RANK = { bad: 3, warn: 2, ok: 1, na: 0 };
export const worst = (list) => list.reduce((w, k) => (RANK[k.status] > RANK[w] ? k.status : w), "ok");

// Last full era, between the era change blocks. Expected mint is the issuance rate over the drip
// window (`LastIssuanceTimestamp` at both blocks). Tolerance is the mint of one IssuanceCadence.
export function dapIssuanceCheck(is, token) {
  const l = is.lastEra;
  const ratePerMs = is.inflation
    ? Number(is.inflation.next_mint[0]) / is.inflationEraMs
    : is.curve
    ? (Number(is.curve.fixedTotalIssuance) * Number(is.curve.percent)) / 100 / YEAR_MS
    : undefined;
  const minted = Number(l.tiDelta);
  const share = (key) => Number(is.pots.find((p) => p.key === key)?.share ?? 0) / 1e9;
  const tol = (ratePerMs ?? minted / l.dripMs) * is.cadence;
  const parts = [];
  if (ratePerMs !== undefined) parts.push({ name: "TotalIssuance increase", actual: minted, expected: ratePerMs * l.dripMs, tol });
  parts.push(
    { name: "ErasValidatorReward", actual: Number(l.reward), expected: share("staker_rewards") * minted, tol: share("staker_rewards") * tol },
    { name: "ErasValidatorIncentiveBudget", actual: Number(l.budget), expected: share("validator_incentive") * minted, tol: share("validator_incentive") * tol },
  );
  // Fees, dust, slashes and expired era pots only add to the buffer, signed rewards take from it.
  const floor = share("buffer") * minted - Number(l.minerRewards ?? 0n);
  const reserve = Number(l.reserveDelta);
  const reserveStatus = reserve <= 0 || reserve < floor / 2 ? "bad" : reserve < floor - share("buffer") * tol || reserve > 2 * share("buffer") * minted ? "warn" : "ok";
  const statuses = parts.map((p) => ({ ...p, status: compare(p.actual, p.expected, p.tol) }));
  statuses.push({ name: "DAP buffer inflow (buffer + staging)", actual: reserve, expected: floor, atLeast: true, status: reserveStatus });
  const rate = ratePerMs === undefined ? "" : ` = issuance rate ${(ratePerMs * 1000 / 10 ** token.decimals).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${token.symbol}/s × drip window ${Math.round(l.dripMs / 1000)} s`;
  const rows = statuses.map((p) => [
    p.status,
    `Era ${l.era} ${p.name}`,
    `${amount(p.actual, token)} (expected ${p.atLeast ? "at least " : ""}${amount(p.expected, token)}${p.name === "TotalIssuance increase" ? rate : ""})`,
  ]);
  if (ratePerMs === undefined) rows.unshift(["warn", `Era ${l.era} TotalIssuance increase`, `${amount(minted, token)} (no expected issuance rate)`]);
  return rows;
}

// Inflation API next_mint total, scaled to the era length (capped by MaxEraDuration) and to the
// TotalIssuance before the era change. The total is linear in both. The validator_payout and
// remainder split also depends on ErasTotalStake, so only the total is checked.
export function legacyPayoutCheck(is, token) {
  const l = is.lastEra;
  const label = `Era ${l.era} EraPaid validator_payout + remainder`;
  if (!l.paid || !is.inflation) return [["warn", label, !l.paid ? "no EraPaid event" : "no Inflation API"]];
  const ms = is.maxEraDuration ? Math.min(l.ms, is.maxEraDuration) : l.ms;
  const scale = (ms / is.inflationEraMs) * (Number(l.tiBefore) / Number(is.totalIssuance));
  const expected = Number(is.inflation.next_mint[0] + is.inflation.next_mint[1]) * scale;
  const actual = Number(l.paid.validator_payout + l.paid.remainder);
  // Float and Perquintill rounding only.
  const status = compare(actual, expected, expected * 1e-9);
  return [[status, label, `${amount(actual, token)} (expected ${amount(expected, token)})`]];
}

// Where the validator set of the planned era is, from election to the relay chain.
export function nextSetStage({ era, relay, election }) {
  if (election && !election.error && election.phase.type !== "Off") return `election ${election.phase.type}`;
  if (era.nextElectionPage !== undefined) return `Staking.NextElectionPage ${era.nextElectionPage}`;
  if (era.outgoing?.id === era.planned) return "StakingRcClient.OutgoingValidatorSet";
  if (relay && !relay.error) {
    if (relay.set?.id === era.planned) return "relay StakingAhClient.ValidatorSet";
    if (relay.nextChanges === era.planned) return "relay StakingAhClient.NextSessionChangesValidators";
  }
  return "exported";
}

export const phaseText = (p) => (p.value === undefined ? p.type : `${p.type}(${p.value})`);

export function fmtAge(s) {
  if (s < 90) return `${Math.max(0, Math.round(s))} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
