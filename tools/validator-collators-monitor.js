// Chain reads and health checks for validator-collators-monitor.html. No DOM code, so Node can run
// it for cross-checks. Mirrors polkadot-sdk my_scripts/validator_collators_reports.py.
import { AccountId, createClient, getSs58AddressInfo } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";

export const NETWORKS = {
  westend: {
    label: "Westend",
    ss58: 42,
    subscan: "https://assethub-westend.subscan.io",
    relay: { key: "relay", name: "Relay chain", url: "wss://westend-rpc.polkadot.io" },
    chains: [
      { key: "asset-hub", name: "Asset Hub", para: 1000, url: "wss://westend-asset-hub-rpc.polkadot.io" },
      { key: "people", name: "People", para: 1004, url: "wss://westend-people-rpc.polkadot.io" },
      { key: "bulletin", name: "Bulletin", para: 2487, url: "wss://westend-bulletin-rpc.polkadot.io" },
    ],
  },
  polkadot: {
    label: "Polkadot",
    ss58: 0,
    subscan: "https://assethub-polkadot.subscan.io",
    relay: { key: "relay", name: "Relay chain", url: "wss://rpc.polkadot.io" },
    chains: [
      { key: "asset-hub", name: "Asset Hub", para: 1000, url: "wss://polkadot-asset-hub-rpc.polkadot.io" },
      { key: "people", name: "People", para: 1004, url: "wss://polkadot-people-rpc.polkadot.io" },
      { key: "bulletin", name: "Bulletin", para: 1010, url: "wss://bulletin-rpc.polkadot.io" },
    ],
  },
};

// Asset Hub blocks after the report's timestamp scanned for the credit, as in the script.
const CREDIT_SCAN = 40;
const CREDIT_EVENTS = new Set(["BlocksCredited", "BlocksIgnored"]);
const ERA_PALLETS = new Set(["ValidatorCollators", "ValidatorSetAnnouncer"]);
const COLLATION = { type: "Collation" };
// Extra Asset Hub blocks read when an announcement to some chain is not in the set-arrival window.
const ANNOUNCE_EXTRA = 30;
const RPC_TIMEOUT = 30_000;

const withTimeout = (p, what) =>
  Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), RPC_TIMEOUT)),
  ]);

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const accountKey = (ss58) => toHex(getSs58AddressInfo(ss58).publicKey);
export const toSs58 = (address, prefix) => AccountId(prefix).dec(getSs58AddressInfo(address).publicKey);

class Chain {
  constructor(def) {
    this.def = def;
    this.client = createClient(getWsProvider(def.url));
    this.api = this.client.getUnsafeApi();
    this.hashes = new Map();
    this.stamps = new Map();
    this.eventsByNumber = new Map();
    this.items = null;
    this.msPerBlock = null;
  }

  async head() {
    const [best] = await withTimeout(this.client.getBestBlocks(), `${this.def.name} best block`);
    this.best = best;
    if (!this.items) {
      const md = unifyMetadata(decAnyMetadata(await withTimeout(this.client.getMetadata(best.hash), "metadata")));
      this.items = new Set(
        md.pallets.flatMap((p) => [
          p.name,
          ...(p.storage?.items ?? []).map((i) => `${p.name}.${i.name}`),
          ...p.constants.map((c) => `${p.name}.${c.name}`),
        ]),
      );
    }
    return best;
  }

  has(path) {
    return this.items.has(path);
  }

  // Storage at the best block, or `undefined` when the item is not in this runtime.
  async q(path, ...args) {
    if (!this.has(path)) return undefined;
    const [pallet, item] = path.split(".");
    return withTimeout(this.api.query[pallet][item].getValue(...args, { at: this.best.hash }), path);
  }

  async entries(path) {
    if (!this.has(path)) return undefined;
    const [pallet, item] = path.split(".");
    return withTimeout(this.api.query[pallet][item].getEntries({ at: this.best.hash }), path);
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
      const p = this.hash(n)
        .then((at) => withTimeout(this.api.query.Timestamp.Now.getValue({ at }), `timestamp #${n}`))
        .then(Number);
      p.catch(() => this.stamps.delete(n));
      this.stamps.set(n, p);
    }
    return this.stamps.get(n);
  }

  async events(n) {
    if (!this.eventsByNumber.has(n)) {
      const p = this.hash(n)
        .then((at) => withTimeout(this.api.query.System.Events.getValue({ at }), `events #${n}`))
        .then((evs) => evs.map(({ event }) => ({ pallet: event.type, name: event.value.type, value: event.value.value })));
      p.catch(() => this.eventsByNumber.delete(n));
      this.eventsByNumber.set(n, p);
    }
    return this.eventsByNumber.get(n);
  }

  // First block whose timestamp is at least `ts`, or best + 1 when none is yet.
  async firstBlockAtOrAfter(ts) {
    const best = this.best.number;
    if ((await this.timestamp(best)) < ts) return best + 1;
    if (this.msPerBlock === null) {
      this.msPerBlock = ((await this.timestamp(best)) - (await this.timestamp(best - 1000))) / 1000;
    }
    const guess = best - Math.round(((await this.timestamp(best)) - ts) / this.msPerBlock);
    let lo = Math.max(guess - 20, 1);
    let hi = Math.min(guess + 20, best);
    while ((await this.timestamp(lo)) > ts) lo = Math.max(lo - 500, 1);
    while (hi < best && (await this.timestamp(hi)) < ts) hi = Math.min(hi + 500, best);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await this.timestamp(mid)) < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  destroy() {
    this.client.destroy();
  }
}

const creditEvents = (events, para) =>
  events.filter((e) => e.pallet === "StakingPointsConverter" && CREDIT_EVENTS.has(e.name) && e.value?.source === para);

export class Monitor {
  constructor(networkKey) {
    this.network = NETWORKS[networkKey];
    this.chains = this.network.chains.map((def) => new Chain(def));
    this.ah = this.chains[0];
    this.relay = new Chain(this.network.relay);
    // Resolved report-to-credit matches and era-start scans, by chain key.
    this.matches = new Map();
    this.eraScans = new Map();
    this.windows = new Map();
  }

  destroy() {
    [...this.chains, this.relay].forEach((c) => c.destroy());
  }

  async refresh({ reports = 3 } = {}) {
    const relayHead = this.relay.head();
    relayHead.catch(() => {});
    const heads = await Promise.allSettled(this.chains.map((c) => c.head()));
    const ah = heads[0].status === "fulfilled" ? await this.readAssetHub() : { error: String(heads[0].reason?.message ?? heads[0].reason) };
    const chains = await Promise.all(
      this.chains.map(async (chain, i) => {
        if (heads[i].status === "rejected") return { def: chain.def, error: String(heads[i].reason?.message ?? heads[i].reason) };
        try {
          return await this.readChain(chain, ah, reports);
        } catch (e) {
          return { def: chain.def, error: String(e?.message ?? e) };
        }
      }),
    );
    if (!ah.error) ah.points = await this.readPoints(ah, chains).catch((e) => ({ error: String(e?.message ?? e) }));
    const paraNames = Object.fromEntries(this.network.chains.map((d) => [d.para, d.name]));
    for (const c of chains) c.checks = c.error ? [] : chainChecks(c, ah, paraNames);
    const relay = await relayHead.then(() => this.readRelay(chains)).catch((e) => ({ error: String(e?.message ?? e) }));
    return { network: this.network.label, at: Date.now(), ah, chains, relay };
  }

  // Relay session set against the set Asset Hub announced, and against the validators collating
  // on any system chain.
  async readRelay(chains) {
    const relay = this.relay;
    const validators = (await relay.q("Session.Validators")) ?? [];
    const relayKeys = new Set(validators.map(accountKey));
    const source = chains.find((c) => c.live?.externalSet);
    const announced = source?.live.externalSet ?? [];
    const announcedKeys = new Set(announced.map(accountKey));
    const collating = [...new Map(chains.flatMap((c) => c.live?.drawn ?? []).map((a) => [accountKey(a), a])).values()];
    return {
      best: relay.best.number,
      session: await relay.q("Session.CurrentIndex"),
      validators: validators.length,
      announced: source ? { chain: source.def.name, era: source.live.externalEra, count: announced.length } : undefined,
      matching: validators.filter((a) => announcedKeys.has(accountKey(a))).length,
      notAnnounced: source ? validators.filter((a) => !announcedKeys.has(accountKey(a))) : [],
      notInRelay: announced.filter((a) => !relayKeys.has(accountKey(a))),
      collating: collating.length,
      collatingInRelay: collating.filter((a) => relayKeys.has(accountKey(a))).length,
      collatingNotInRelay: collating.filter((a) => !relayKeys.has(accountKey(a))),
    };
  }

  async readAssetHub() {
    const ah = this.ah;
    const active = await ah.q("Staking.ActiveEra");
    return {
      converter: ah.has("StakingPointsConverter"),
      byService: ah.has("Staking.ErasRewardPointsByService"),
      era: active?.index,
      eraStart: active?.start !== undefined ? Number(active.start) : undefined,
      maxPointsPerService: await ah.constant("StakingPointsConverter.MaxPointsPerService"),
    };
  }

  async readChain(chain, ah, reports) {
    const best = chain.best.number;
    const bestTs = await chain.timestamp(best);
    const para = await chain.q("ParachainInfo.ParachainId");
    const base = { def: chain.def, best, bestTs, para };
    const invulnerables = (await chain.q("CollatorSelection.Invulnerables")) ?? [];
    const candidates = ((await chain.q("CollatorSelection.CandidateList")) ?? []).map((c) => c.who);
    const collatorSelection = {
      invulnerables: invulnerables.length,
      candidates: candidates.length,
      desiredCandidates: await chain.q("CollatorSelection.DesiredCandidates"),
    };
    const conv = this.ah;
    const pointsConfig = ah.error
      ? { error: true }
      : !ah.converter
      ? { converter: false }
      : {
          converter: true,
          pointsPerService: await conv.q("StakingPointsConverter.PointsPerService", chain.def.para, COLLATION),
          maxPointsPerService: ah.maxPointsPerService,
        };
    const session = await chain.q("Session.Validators");
    if (!chain.has("ValidatorCollators")) {
      return { ...base, deployed: false, collatorSelection, pointsConfig, sessionCount: session?.length };
    }

    const [maxCollators, period, eraDuration, margin, pending, receivedAt, maxValidators, maxEntries] = await Promise.all([
      chain.q("ValidatorCollators.MaxCollators"),
      chain.q("ValidatorCollators.ReportPeriod"),
      chain.q("ValidatorCollators.ExpectedEraDuration"),
      chain.q("ValidatorCollators.ReportMargin"),
      chain.q("ValidatorCollators.PendingRotation"),
      chain.q("ValidatorCollators.ExternalSetReceivedAt"),
      chain.constant("ValidatorCollators.MaxValidators"),
      chain.constant("ValidatorCollators.MaxEntriesPerReport"),
    ]);
    const drawnEntry = await chain.q("ValidatorCollators.DrawnCollators");
    const external = await chain.q("ValidatorCollators.ExternalValidatorSet");
    const drawn = drawnEntry?.collators ?? [];
    const drawnKeys = new Set(drawn.map(accountKey));
    const sessionKeys = new Set((session ?? []).map(accountKey));
    const drawnInSession = drawn.filter((a) => sessionKeys.has(accountKey(a)));
    // Session members by origin, each counted once: drawn first, then invulnerables, then candidates.
    const inList = (list) => new Set(list.map(accountKey));
    const [invKeys, candKeys] = [inList(invulnerables), inList(candidates)];
    const notDrawn = (session ?? []).filter((a) => !drawnKeys.has(accountKey(a)));
    const sessionSplit = {
      drawn: drawnInSession,
      invulnerables: notDrawn.filter((a) => invKeys.has(accountKey(a))),
      candidates: notDrawn.filter((a) => !invKeys.has(accountKey(a)) && candKeys.has(accountKey(a))),
      other: notDrawn.filter((a) => !invKeys.has(accountKey(a)) && !candKeys.has(accountKey(a))),
    };

    const lastReport = Math.floor(best / period) * period;
    const authored = (await chain.entries("ValidatorCollators.AuthoredBlocks")) ?? [];
    const byDrawn = authored.filter((e) => drawnKeys.has(accountKey(e.keyArgs[0])));
    const others = authored.filter((e) => !drawnKeys.has(accountKey(e.keyArgs[0])));
    // One report window is often shorter than an Aura round, so the counts of the previous window,
    // read just before the last report, are added to tell who authored lately.
    const previous = await this.previousWindow(chain, lastReport);
    const recentKeys = new Set([...authored, ...previous].map((e) => accountKey(e.keyArgs[0])));
    const slot = chain.has("Aura.SlotDuration") ? Number(await chain.constant("Aura.SlotDuration")) : undefined;
    const coveredMs = bestTs - (await chain.timestamp(Math.max(lastReport - period, 1)));

    const reportRows = await this.readReports(chain, period, lastReport, reports, ah);
    const eraEvents = await this.readEraEvents(chain, ah, receivedAt !== undefined ? Number(receivedAt) : undefined, external?.era);

    return {
      ...base,
      deployed: true,
      collatorSelection,
      pointsConfig,
      config: {
        maxCollators,
        period,
        eraDuration: Number(eraDuration),
        margin: Number(margin),
        pending: pending?.type,
        maxValidators,
        maxEntries,
        receivedAt: receivedAt !== undefined ? Number(receivedAt) : undefined,
      },
      live: {
        drawnEra: drawnEntry?.era,
        drawn,
        externalEra: external?.era,
        externalCount: external?.validators?.length,
        externalSet: external?.validators,
        sessionCount: session?.length,
        drawnInSession: drawnInSession.length,
        sessionSplit,
        lastReport,
        blocksSince: best - lastReport,
        drawnAuthors: byDrawn.length,
        drawnBlocks: byDrawn.reduce((s, e) => s + e.value, 0),
        otherBlocks: others.reduce((s, e) => s + e.value, 0),
        waiting: drawnInSession.filter((a) => !recentKeys.has(accountKey(a))),
        coveredMs,
        roundMs: slot && session ? slot * (session.length + 1) : undefined,
      },
      reports: reportRows,
      eraEvents,
    };
  }

  async previousWindow(chain, lastReport) {
    const cacheKey = `${chain.def.key}:${lastReport}`;
    if (!this.windows.has(cacheKey)) {
      const p = chain
        .hash(lastReport - 1)
        .then((at) => withTimeout(chain.api.query.ValidatorCollators.AuthoredBlocks.getEntries({ at }), "AuthoredBlocks before the report"));
      p.catch(() => this.windows.delete(cacheKey));
      this.windows.set(cacheKey, p);
    }
    return this.windows.get(cacheKey);
  }

  async readReports(chain, period, lastReport, count, ahInfo) {
    const numbers = Array.from({ length: count }, (_, i) => lastReport - i * period).filter((n) => n > 0);
    return Promise.all(numbers.map((n) => this.readReport(chain, n, ahInfo)));
  }

  async readReport(chain, n, ahInfo) {
    const cacheKey = `${chain.def.key}:${n}`;
    if (this.matches.has(cacheKey)) return this.matches.get(cacheKey);
    const events = (await chain.events(n)).filter((e) => e.pallet === "ValidatorCollators");
    const report = events.find((e) => e.name === "BlocksReported" || e.name === "BlocksReportFailed");
    const ts = await chain.timestamp(n);
    const row = { n, ts };
    if (!report) {
      row.kind = events.some((e) => e.name === "CollatorsDrawn") ? "rotation" : "none";
      this.matches.set(cacheKey, row);
      return row;
    }
    row.kind = report.name;
    row.value = report.value;
    if (ahInfo.error) {
      row.credit = { status: "unknown" };
      return row;
    }
    const sent = report.name === "BlocksReported" ? report.value.reported : 0;
    if (sent === 0 || !ahInfo.converter) {
      row.credit = { status: report.name === "BlocksReportFailed" ? "failed" : "nothing" };
      this.matches.set(cacheKey, row);
      return row;
    }
    const para = chain.def.para;
    const ah = this.ah;
    if (chain === ah) {
      const found = creditEvents(await ah.events(n), para);
      row.credit = found.length ? { status: statusOf(found), block: n, events: found, ts } : { status: "missing" };
      this.matches.set(cacheKey, row);
      return row;
    }
    const start = await ah.firstBlockAtOrAfter(ts);
    const end = Math.min(start + CREDIT_SCAN - 1, ah.best.number);
    for (let m = start; m <= end; m += 5) {
      const batch = Array.from({ length: Math.min(5, end - m + 1) }, (_, i) => m + i);
      const evs = await Promise.all(batch.map((b) => ah.events(b)));
      const hit = evs.findIndex((e) => creditEvents(e, para).length);
      if (hit >= 0) {
        const found = creditEvents(evs[hit], para);
        row.credit = { status: statusOf(found), block: batch[hit], events: found, ts: await ah.timestamp(batch[hit]) };
        this.matches.set(cacheKey, row);
        return row;
      }
    }
    const windowOpen = end < start + CREDIT_SCAN - 1;
    row.credit = { status: windowOpen ? "pending" : "missing", from: start, to: start + CREDIT_SCAN - 1 };
    if (!windowOpen) this.matches.set(cacheKey, row);
    return row;
  }

  // Events of the blocks around the arrival of the latest set: ValidatorSetReceived, the forced
  // rotations with CollatorsDrawn, and the announcer events on Asset Hub. Anchored at
  // ExternalSetReceivedAt, or at the Asset Hub era start once the early report removed it.
  async readEraEvents(chain, ah, receivedAt, era) {
    const anchor = receivedAt ?? ah.eraStart;
    if (anchor === undefined) return { blocks: [], events: [] };
    const cacheKey = `${chain.def.key}:${era}:${anchor}`;
    if (this.eraScans.has(cacheKey)) return this.eraScans.get(cacheKey);
    // Several blocks share a timestamp, and the set lands in one of those stamped with `receivedAt`.
    // The two forced rotations follow in the next blocks.
    const [from, to] =
      receivedAt !== undefined
        ? [await chain.firstBlockAtOrAfter(receivedAt), (await chain.firstBlockAtOrAfter(receivedAt + 1)) + 3]
        : [await chain.firstBlockAtOrAfter(anchor - 30_000), await chain.firstBlockAtOrAfter(anchor + 40_000)];
    const read = async (a, b) => {
      const numbers = Array.from({ length: Math.max(b - a + 1, 0) }, (_, i) => a + i);
      const perBlock = await Promise.all(numbers.map((n) => chain.events(n)));
      return perBlock.flatMap((evs, i) => evs.filter((e) => ERA_PALLETS.has(e.pallet)).map((e) => ({ n: numbers[i], ...e })));
    };
    let last = Math.min(to, chain.best.number);
    const events = await read(from, last);
    // On Asset Hub, keep reading until every other chain of the network has an announcer event.
    const missing = () => {
      const seen = new Set(events.filter((e) => e.pallet === "ValidatorSetAnnouncer").map((e) => e.value.destination));
      return chain === this.ah && this.network.chains.some((d) => d.para !== 1000 && !seen.has(d.para));
    };
    while (missing() && last < Math.min(to + ANNOUNCE_EXTRA, chain.best.number)) {
      const next = Math.min(last + 5, to + ANNOUNCE_EXTRA, chain.best.number);
      events.push(...(await read(last + 1, next)));
      last = next;
    }
    const result = { blocks: [from, last], anchor: receivedAt !== undefined ? "ExternalSetReceivedAt" : "ActiveEra.start", events };
    if (last >= to && (!missing() || last >= to + ANNOUNCE_EXTRA)) this.eraScans.set(cacheKey, result);
    return result;
  }

  async readPoints(ah, chains) {
    const conv = this.ah;
    if (ah.era === undefined) return { era: undefined };
    const all = await conv.q("Staking.ErasRewardPoints", ah.era);
    const byService = ah.byService ? await conv.q("Staking.ErasRewardPointsByService", ah.era, COLLATION) : undefined;
    const allByKey = new Map((all?.individual ?? []).map(([who, p]) => [accountKey(who), p]));
    const drawnOn = new Map();
    for (const c of chains) {
      for (const who of c.live?.drawn ?? []) {
        const k = accountKey(who);
        drawnOn.set(k, [...(drawnOn.get(k) ?? []), c.def.name]);
      }
    }
    const top = (byService?.individual ?? [])
      .map(([who, p]) => ({ who, collation: p, total: allByKey.get(accountKey(who)) ?? 0, drawnOn: drawnOn.get(accountKey(who)) ?? [] }))
      .sort((a, b) => b.collation - a.collation);
    const perChain = chains.map((c) => {
      const pps = c.pointsConfig?.pointsPerService ?? 0;
      const credits = (c.reports ?? []).filter(
        (r) => r.credit?.events && ah.eraStart !== undefined && r.credit.ts >= ah.eraStart,
      );
      const blocks = credits.flatMap((r) => r.credit.events.filter((e) => e.name === "BlocksCredited")).reduce((s, e) => s + e.value.blocks, 0);
      return { name: c.def.name, reports: credits.length, blocks, points: blocks * Math.min(pps, ah.maxPointsPerService ?? pps) };
    });
    return {
      era: ah.era,
      total: all?.total,
      collationTotal: byService?.total,
      byServicePresent: ah.byService,
      top,
      perChain,
    };
  }
}

const statusOf = (events) => (events.some((e) => e.name === "BlocksCredited") ? "credited" : "ignored");

// Health checks as "label: value" rows. Status: ok, warn, bad, na (not applicable).
export function chainChecks(c, ah, paraNames) {
  const checks = [];
  const add = (label, status, value, extra = {}) => checks.push({ label, status, value, ...extra });
  const n = (v) => Number(v).toLocaleString("en-US");
  const age = (Date.now() - c.bestTs) / 1000;
  add("Best block", age < 90 ? "ok" : age < 300 ? "warn" : "bad", `#${n(c.best)}, ${fmtAge(age)} ago`);
  if (!c.deployed) {
    add("ValidatorCollators", "na", "not deployed yet");
    return checks;
  }
  const { config, live } = c;
  const capOff = config.maxCollators?.type === "None";

  if (ah.era === undefined) add("Set received", "na", "active era unknown");
  else if (live.externalEra === undefined) add("Set received", "warn", "none");
  else if (live.externalEra === ah.era) add("Set received", "ok", `era ${live.externalEra}`);
  else add("Set received", "warn", `era ${live.externalEra}, active era ${ah.era}`);

  const drawn = live.drawn.length;
  const rotation = config.pending === "Idle" ? "" : `rotation ${config.pending}`;
  if (capOff) add("Drawn in session", "na", "MaxCollators is None");
  else if (!drawn) add("Drawn in session", rotation ? "warn" : "bad", "0 / 0", { detail: rotation });
  else {
    const status = live.drawnInSession === drawn ? (rotation ? "warn" : "ok") : live.drawnInSession || rotation ? "warn" : "bad";
    add("Drawn in session", status, `${live.drawnInSession} / ${drawn}`, { detail: rotation });
  }

  const window = fmtAge(live.coveredMs / 1000);
  const authored = live.drawnInSession - live.waiting.length;
  if (capOff || !live.drawnInSession) add("Drawn authoring", "na", "none in session");
  else if (!live.roundMs) add("Drawn authoring", "na", "Aura slot duration unknown");
  else if (live.coveredMs < live.roundMs) add("Drawn authoring", "na", `${authored} / ${live.drawnInSession} so far`, { detail: `round in progress, ${window}` });
  else add("Drawn authoring", live.waiting.length ? "warn" : "ok", `${authored} / ${live.drawnInSession}`, { detail: `last ${window}`, who: live.waiting });

  const sent = c.reports.filter((r) => r.kind === "BlocksReported" || r.kind === "BlocksReportFailed");
  // A credit lands some blocks after a remote report, so a fresh pending one is judged by the previous report.
  const fresh = sent[0]?.credit?.status === "pending" && Date.now() - sent[0].ts < 120_000;
  const [status, value] = reportCheck(fresh && sent[1] ? sent[1] : sent[0], capOff, n, c.def.para === 1000);
  add("Last report", fresh && !sent[1] ? "na" : status, value, { detail: fresh ? `#${n(sent[0].n)} credit due shortly` : "" });

  const failed = c.reports.filter((r) => r.kind === "BlocksReportFailed").map((r) => `#${n(r.n)}`);
  if (failed.length) add("BlocksReportFailed", "bad", `at ${failed.join(", ")}`);
  const unexpected = c.eraEvents.events.filter((e) => e.name === "Unexpected").map((e) => `#${n(e.n)}`);
  if (unexpected.length) add("Unexpected", "bad", `at ${unexpected.join(", ")}`);

  const pps = c.pointsConfig.pointsPerService;
  const lastCredit = c.reports.find((r) => r.credit?.events)?.credit;
  if (c.pointsConfig.error) add("PointsPerService", "na", "Asset Hub unreachable");
  else if (!c.pointsConfig.converter) add("PointsPerService", "na", "converter not deployed yet");
  else if (!pps) add("PointsPerService", capOff ? "na" : "warn", "0");
  else if (lastCredit && lastCredit.status !== "credited") add("PointsPerService", "warn", String(pps), { detail: `last credit ${lastCredit.status}` });
  else add("PointsPerService", "ok", String(pps));

  if (c.def.para === 1000) {
    const announcer = c.eraEvents.events.filter((e) => e.pallet === "ValidatorSetAnnouncer");
    const name = (para) => paraNames[para] ?? `para ${para}`;
    const sentTo = announcer.filter((e) => e.name === "AnnouncementSent").map((e) => e.value.destination);
    const eras = [...new Set(announcer.map((e) => e.value.era))].join(", ");
    if (sentTo.length) add("Set announced", "ok", `${sentTo.map(name).join(", ")} (era ${eras})`);
    const notSent = Object.keys(paraNames).map(Number).filter((p) => p !== 1000 && !sentTo.includes(p));
    if (notSent.length) {
      const reasons = announcer.filter((e) => e.name !== "AnnouncementSent").map((e) => e.name);
      add("Set not announced", "bad", notSent.map(name).join(", "), { detail: reasons.join(", ") });
    }
    const p = ah.points;
    if (!p || p.error || !p.byServicePresent) add("Points current era", "na", "not available");
    else if (p.collationTotal) add("Points current era", "ok", `${n(p.collationTotal)}, era ${p.era}`);
    else add("Points current era", Date.now() - ah.eraStart > 900_000 ? "warn" : "na", `0, era ${p.era}`);
  }
  return checks;
}

function reportCheck(r, capOff, n, self) {
  if (!r) return [capOff ? "na" : "warn", "none in the blocks read"];
  if (r.kind === "BlocksReportFailed") return ["bad", `#${n(r.n)} failed`];
  switch (r.credit.status) {
    case "nothing": return ["na", `#${n(r.n)} sent nothing`];
    case "credited": return ["ok", `#${n(r.n)} credited ${self ? "in the same block" : `at AH #${n(r.credit.block)}`}`];
    case "pending": return ["warn", `#${n(r.n)} credit pending`];
    case "missing": return ["bad", `#${n(r.n)} no credit found`];
    case "unknown": return ["na", `#${n(r.n)}, Asset Hub unreachable`];
    default: return ["warn", `#${n(r.n)} ${r.credit.status}`];
  }
}

const RANK = { bad: 3, warn: 2, ok: 1, na: 0 };
export function overall(c) {
  if (c.error) return "bad";
  const worst = c.checks.reduce((w, k) => (RANK[k.status] > RANK[w] ? k.status : w), "ok");
  return !c.deployed && worst === "ok" ? "na" : worst;
}

export function fmtAge(s) {
  if (s < 90) return `${Math.max(0, Math.round(s))} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
