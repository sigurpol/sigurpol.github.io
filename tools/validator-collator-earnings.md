# Validator earnings with collation

How the validator earnings with collation tool calculates its numbers. The page and the CLI
(`validator_collator_earnings.py`) use the same model and give the same numbers.

## What the tool answers

Every Polkadot validator validates on the relay chain. With `pallet-validator-collators`, validators
can also collate on system chains: Asset Hub (para 1000), People (para 1004) and Bulletin
(para 1010). The tool answers three questions.

- What does a validator earn per month if it validates only, or also collates on some or all of
  these chains?
- Does that cover the cost of a metanode, the machine that runs the whole stack for one validator?
- How many points per block would collation need to pay for the metanode?

The era payout is fixed by inflation. Collation points add no DOT. They move reward between
validators.

## Where the default values come from

The defaults are read from Polkadot with the `dot` CLI on 2026-11-26.

| Value | Source |
|---|---|
| Budget shares | Asset Hub `Dap.BudgetAllocation` |
| Issuance per era | The two pots of era 2365 (`Staking.ErasValidatorReward` and `ErasValidatorIncentiveBudget`) divided by their shares |
| Relay points per era | Asset Hub `Staking.ErasRewardPoints` total, mean of eras 2360 to 2364 |
| Validators scored | Number of entries in `ErasRewardPoints`, about 400 in those eras |
| Active validators | Asset Hub `Staking.ValidatorCount`, 320 |
| Self-stake share | Median of own / total in `Staking.ErasStakersOverview`, era 2364 |
| Block times | Measured from `Timestamp.Now` over the last 10,000 blocks of each chain |
| Invulnerables and candidates | `CollatorSelection.Invulnerables` and `CandidateList` on each chain |

The DOT price is an input. The metanode cost is an input and defaults to 2000 USD per month.

## Where the reward pots come from

`pallet-dap` mints new DOT every minute along an issuance curve. Governance splits it between budget
recipients with `Dap.BudgetAllocation`. The shares must add up to 100%. On 2026-11-26 they were:

- `staker_rewards` 45.2%. This is the staker pot. It is paid to validators and nominators by era
  points and stake.
- `validator_incentive` 12.1%. This is the incentive budget. It is paid to validators by self-stake
  weight and era points.
- `buffer` 42.7%. It does not reach validators.

At the end of each era the two pots collected during that era are moved into era pots. So the staker
pot is the issuance per era times the `staker_rewards` share, and the incentive budget is the
issuance per era times the `validator_incentive` share. Era 2365 gives about 153,132 DOT per era for
both pots.

The `validator_incentive` share was lowered in steps by governance. It was 22.6% up to era 2348,
18.8% from era 2350, 15.1% from era 2358 and 12.1% from era 2365. Eras 2349, 2357 and 2364 had a
change in the middle. The `staker_rewards` share stayed at 45.2%. The buffer took the difference.

The tool lets the issuance and both shares be changed. Whatever the two shares leave goes to the
buffer and other recipients, which do not affect validator earnings.

## How validator earnings are computed

**Validator earnings** are the self-stake share of the staker pot plus the validator's share of
the incentive budget. Nominators' rewards are not included. The tool also shows the **gross**
amount, the validator's whole share of the reward with nominators included.

Both pots are shared by era points. A validator with a larger share of the era's points gets a
larger share of the pot. The incentive budget is split by weight × points, and the other validators
are treated as average.

For one era:

- `P` is the total of all era points.
- `pot` is the staker pot and `budget` the incentive budget.
- `own` is the validator's self-stake share of its exposure.
- `w` is the validator's incentive weight divided by the mean weight. In era 2364 the 10th
  percentile was 0.63 and the 90th was 1.37. The default is 1.

Then one era point is worth `(pot + w·budget) / P` gross and `(pot·own + w·budget) / P` in
validator earnings. A month is the era amount times the eras per month, 30 by default.

### Relay points

Relay era points have three sources in the runtime code (Westend at `polkadot-stable2611-rc2`, the
Polkadot runtime is assumed to match).

- 20 points per relay block authored (`staking-async` ah-client, `do_note_author`, `PointsPerBlock`).
- 20 points per backer of each included parachain candidate (`reward_points.rs`, `reward_backing`).
- 20 points per dispute statement.

Approvals and availability bitfields earn nothing. Block authoring gives about 288,000 points per
era, one block per 6 s slot. That is under 1% of the observed 41.6 million. Backing is almost all of
it.

A validator backs the candidates of the core its group is assigned to. With fewer validators the
groups shrink, but each validator still backs about as often. So the tool keeps relay points per
validator fixed. `R`, the relay points per validator per era, is the relay total read from chain
divided by the validators scored. With `N` active validators the relay total is `N·R`.

### Collation points and the draw

At each era start Asset Hub sends the active validator set to each chain. Each chain draws up to
`MaxCollators` validators from the metanodes collating on that chain. A metanode collates on a chain
when it has session keys and a running collator for it. The drawn validators collate next to the
chain's own invulnerables and candidates, and the blocks are split evenly between all of them.

Each chain reports the blocks authored by validators to Asset Hub. Asset Hub credits
`PointsPerService` era points per block. The invulnerables and candidates earn nothing. The tool
assumes no metanode is an invulnerable or candidate on any chain.

Per chain:

- `K` is the number of metanodes collating on the chain, all active validators by default. It counts
  the validator when it collates there. If it does not, `K` drops by one and it is not drawn.
- `n = min(MaxCollators, K)` is the number of drawn validators. `UpTo(n)` caps the draw at n, `All`
  draws all `K` and `None` draws nobody.
- `b = blocks per era / (n + invulnerables and candidates)` is the number of blocks per author.
- `x = PointsPerService · b` is the era points of one drawn validator.
- `q = n / K` is the validator's chance of being picked in an era. It is 0 where the validator does
  not collate.

The collation total is `C = Σ n·x` over the chains, and `P = N·R + C`. The validator earns
`R + Σ q·x` points per era on average over the draws.

## The three options

The tool compares three options for one validator. The other validators keep collating as the
chain settings say.

1. Validates and collates on every chain.
2. Validates only. It is not among the collating metanodes anywhere and earns relay points only.
3. Validates and collates on the chains ticked next to the table (`--collate-on` in the CLI).

Each option has its own total `P`, because the validator's choice changes who can be drawn. A
validator that only validates earns less than if no validator collated, because the collation
points of the others dilute the fixed payout.

The detailed table also shows a reference row where no validator collates, `(pot + w·budget) / N`.
Averaged over all validators, the reward always equals this reference.

## Break-even

Break-even asks what `validator_incentive` share would let a validator that collates on every chain
cover its metanode cost. Everything else stays fixed. That includes the issuance, the `staker_rewards` share,
points per block, caps, collating metanodes, the self-stake share and the weight.

A validator's earnings grow in a straight line with the share, so the tool solves for it directly.
With `E` eras per month, `R + S` the validator's era points (relay plus its average collation
points), `P` the total era points, `I` the issuance per era and `M` the metanode cost in DOT:

```
E·(R + S) / P · (pot·own + w·I·s) = M
s = (M·P / (E·(R + S)) − pot·own) / (w·I)
```

If the current earnings already cover `M`, the tool says so. If `s` is more than what
`staker_rewards` leaves (100% minus that share), the share alone can't cover the cost. At the
defaults `s` is about 20.2%, against 12.1% today.

### Why points per block don't help in the plain draw

Raising points per block on every chain by a multiple `k` makes collation a larger part of all era
points. A validator's earnings then approach its share of all collation points times the whole pot.
A validator that collates no more often than the average validator holds at most `1/N` of the
collation points. So its earnings can never exceed the amount it would get if no validator
collated. With every validator in the draw this is always the case.

Only a validator that collates more often than average gains from higher points per block. That
happens when fewer metanodes than active validators collate on a chain. For that case the tool also
shows the points per block at which the earnings reach `M`, with `S = Σ q·PointsPerService·b` and
`C1 = Σ n·PointsPerService·b`:

```
E·V·(R + k·S) / (N·R + k·C1) = M
k = R·(M·N − E·V) / (E·V·S − M·C1)
```

Here `V = pot·own + w·budget`. Earnings rise with `k` towards `E·V·S / C1`. If that limit is not
above `M`, points per block alone can't cover the cost.

## Assumptions

- One metanode per validator runs all the time. It runs the whole service layer: relay validation,
  collation and full nodes for the system chains, Bulletin storage, RPC and other services. The tool
  counts only era points from relay validation and collation against its cost. The cost is the same
  in every option.
- Drawn validators author every turn.
- No metanode is an invulnerable or candidate on any chain.
- Relay points per validator stay fixed when the number of validators changes. This assumes the
  number of cores and their use stay the same. If the set shrank so far that backing groups hit
  their minimum size, points per validator could rise.
- The observed relay total fits about 143 backing votes per relay block, for example 29 candidates
  with 5 backers each. This is an inference, not a chain read.
- The incentive weights of the other validators are treated as average.
- Eras last 24 hours and a month has 30 eras.

## What isn't on Polkadot yet

`ValidatorCollators` and `StakingPointsConverter` are not on Polkadot yet. Their values are
proposals. The defaults are the Westend values.

- `MaxCollators`: `UpTo(20)` on each chain.
- `PointsPerService (para, Collation)`: 20 on Asset Hub, 10 on People, 20 on Bulletin.
