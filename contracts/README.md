# NeiroMiner contracts

## Setup

```
cd contracts
npm install
npx hardhat compile
npx hardhat test
```

If `npx hardhat compile` fails to reach `binaries.soliditylang.org` (e.g. in a
network-restricted sandbox), install `solc` from npm instead and seed
Hardhat's compiler cache from it — see git history of this file's directory
for the exact steps used during development. On a normal machine with open
internet access this isn't necessary; Hardhat downloads the compiler itself.

## Deploying

```
ADMIN_ADDRESS=0x... \
DEPLOYER_PRIVATE_KEY=0x... \
npx hardhat run scripts/deploy.js --network robinhoodChain
```

`scripts/deploy.js` defaults the token/fee-wallet addresses to the ones
already in use on the live site. Override any of them with
`NEIRO_TOKEN_ADDRESS`, `LP_WALLET_ADDRESS`, `OWNER_FEE_WALLET_ADDRESS`,
`ECO_WALLET_ADDRESS` if they ever change.

After deploying:
1. Verify the contract on the Robinhood Chain explorer.
2. As the admin wallet, `approve` NEIRO to the contract and call
   `notifyRewardAmount(amount, durationSeconds)` to open the first reward
   stream — the dashboard shows "No active stream" until this happens.
3. Put the deployed address into `MINER_ADDRESS` at the top of `mining.js`
   in the repo root. The dashboard runs in read-only "preview mode" until
   that's set.

## Design notes / assumptions made

- **"1% goes to LP then burn"**: the contract sends that 1% directly to the
  given LP wallet as plain NEIRO. It does not perform an on-chain
  swap-and-add-liquidity-then-burn-the-LP-token sequence — that pattern
  (popularized by SafeMoon-style tokens) depends on trusting a DEX router at
  transaction time and is a well-documented source of sandwich/MEV and
  accounting bugs. If you want liquidity added and the LP token burned, do
  it as a manual or multisig-controlled treasury operation from that wallet.
- **Reward funding**: rewards come from `notifyRewardAmount`, called by the
  admin wallet with tokens it already holds/approves, plus forfeited
  principal from early exits. Nothing is funded by other users' deposits.
- **"Pre-selected pairs" (memes, tokenized SPCX/NVDA, etc.)**: v1 is a
  themed display only on the mining page. The contract does not trade or
  weight yield by those pairs' prices. Wiring real oracle-driven yield to
  specific pairs is a separate, larger project (needs a reliable price feed
  per asset and defenses against oracle manipulation) — don't market it as
  live until it's actually built.
- **Early exit (10%)**: 3% follows the standard buy/withdraw fee split
  (1% LP, 1% platform, 1% eco); the remaining 7% is injected into the
  live reward stream for stakers who keep their lock, funded entirely by
  the exiting user's own forfeited principal.
- **Owner powers are deliberately minimal**: fund the reward stream, pause
  new deposits. There is no function that can move user principal or
  already-committed reward funds, and fee wallets/percentages are immutable
  constructor args, not owner-settable.
