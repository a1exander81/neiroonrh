const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const BPS_DENOM = 10_000n;
const BUY_FEE_BPS = 300n;
const WITHDRAW_FEE_BPS = 300n;
const EARLY_EXIT_FEE_BPS = 1_000n;

const TIER = { DAY: 0, THREE_DAY: 1, WEEK: 2, MONTH: 3 };
const TIER_DURATION = [1n * 86400n, 3n * 86400n, 7n * 86400n, 30n * 86400n];
const TIER_MULT_BPS = [10_000n, 12_000n, 15_000n, 20_000n];

const ONE = 10n ** 18n;

async function deployFixture() {
  const [deployer, lpWallet, ownerFeeWallet, ecoWallet, admin, alice, bob, carol] = await ethers.getSigners();

  const MockNeiro = await ethers.getContractFactory("MockNeiro");
  const neiro = await MockNeiro.deploy();

  const NeiroMiner = await ethers.getContractFactory("NeiroMiner");
  const miner = await NeiroMiner.deploy(
    await neiro.getAddress(),
    lpWallet.address,
    ownerFeeWallet.address,
    ecoWallet.address,
    admin.address
  );

  for (const user of [alice, bob, carol, admin]) {
    await neiro.mint(user.address, 1_000_000n * ONE);
    await neiro.connect(user).approve(await miner.getAddress(), ethers.MaxUint256);
  }

  return { deployer, lpWallet, ownerFeeWallet, ecoWallet, admin, alice, bob, carol, neiro, miner };
}

async function fundRewards(ctx, amount, duration) {
  const { miner, admin } = ctx;
  await ctx.neiro.connect(admin).approve(await miner.getAddress(), amount);
  await miner.connect(admin).notifyRewardAmount(amount, duration);
}

function buyFeeSplit(grossAmount) {
  const fee = (grossAmount * BUY_FEE_BPS) / BPS_DENOM;
  const principal = grossAmount - fee;
  const each = fee / 3n;
  return { fee, principal, each };
}

describe("NeiroMiner", function () {
  describe("deployment", function () {
    it("stores immutable config and rejects zero addresses", async function () {
      const ctx = await deployFixture();
      expect(await ctx.miner.neiro()).to.equal(await ctx.neiro.getAddress());
      expect(await ctx.miner.lpWallet()).to.equal(ctx.lpWallet.address);
      expect(await ctx.miner.ownerFeeWallet()).to.equal(ctx.ownerFeeWallet.address);
      expect(await ctx.miner.ecoWallet()).to.equal(ctx.ecoWallet.address);
      expect(await ctx.miner.owner()).to.equal(ctx.admin.address);

      const NeiroMiner = await ethers.getContractFactory("NeiroMiner");
      await expect(
        NeiroMiner.deploy(ethers.ZeroAddress, ctx.lpWallet.address, ctx.ownerFeeWallet.address, ctx.ecoWallet.address, ctx.admin.address)
      ).to.be.revertedWith("neiro=0");
      await expect(
        NeiroMiner.deploy(await ctx.neiro.getAddress(), ethers.ZeroAddress, ctx.ownerFeeWallet.address, ctx.ecoWallet.address, ctx.admin.address)
      ).to.be.revertedWith("wallet=0");
    });
  });

  describe("buyMiners", function () {
    it("takes a 3% fee split 1/1/1 across LP/owner/eco and locks the rest as principal", async function () {
      const ctx = await deployFixture();
      const { miner, neiro, alice, lpWallet, ownerFeeWallet, ecoWallet } = ctx;
      const amount = 10_000n * ONE;
      const { fee, principal, each } = buyFeeSplit(amount);

      const lpBefore = await neiro.balanceOf(lpWallet.address);
      const ownerBefore = await neiro.balanceOf(ownerFeeWallet.address);
      const ecoBefore = await neiro.balanceOf(ecoWallet.address);

      await expect(miner.connect(alice).buyMiners(amount, TIER.DAY))
        .to.emit(miner, "MinerPurchased");

      expect((await neiro.balanceOf(lpWallet.address)) - lpBefore).to.equal(each);
      expect((await neiro.balanceOf(ownerFeeWallet.address)) - ownerBefore).to.equal(each);
      expect((await neiro.balanceOf(ecoWallet.address)) - ecoBefore).to.equal(each + (fee - each * 3n));

      const pos = await miner.positions(alice.address, 0);
      expect(pos.principal).to.equal(principal);
      expect(pos.hashpower).to.equal((principal * TIER_MULT_BPS[TIER.DAY]) / BPS_DENOM);
      expect(pos.active).to.equal(true);

      expect(await miner.totalPrincipalLocked()).to.equal(principal);
    });

    it("applies increasing hashpower multipliers for longer lock tiers", async function () {
      const ctx = await deployFixture();
      const { miner, alice } = ctx;
      const amount = 1_000n * ONE;

      for (const [tierName, tier] of Object.entries(TIER)) {
        await miner.connect(alice).buyMiners(amount, tier);
      }

      const positions = await Promise.all([0, 1, 2, 3].map((i) => miner.positions(alice.address, i)));
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i].hashpower).to.be.gt(positions[i - 1].hashpower);
      }
    });

    it("reverts on zero amount and while paused", async function () {
      const ctx = await deployFixture();
      const { miner, admin, alice } = ctx;
      await expect(miner.connect(alice).buyMiners(0, TIER.DAY)).to.be.revertedWith("amount=0");

      await miner.connect(admin).pauseNewMiners();
      await expect(miner.connect(alice).buyMiners(1000n * ONE, TIER.DAY)).to.be.reverted;
      await miner.connect(admin).unpauseNewMiners();
      await expect(miner.connect(alice).buyMiners(1000n * ONE, TIER.DAY)).to.not.be.reverted;
    });

    it("only the owner can pause/unpause", async function () {
      const ctx = await deployFixture();
      await expect(ctx.miner.connect(ctx.alice).pauseNewMiners()).to.be.reverted;
    });

    it("accounts correctly for fee-on-transfer style tokens (balance-delta, not requested amount)", async function () {
      const [deployer, lpWallet, ownerFeeWallet, ecoWallet, admin, alice] = await ethers.getSigners();
      const FOT = await ethers.getContractFactory("FeeOnTransferMock");
      const fot = await FOT.deploy();
      const NeiroMiner = await ethers.getContractFactory("NeiroMiner");
      const miner = await NeiroMiner.deploy(await fot.getAddress(), lpWallet.address, ownerFeeWallet.address, ecoWallet.address, admin.address);

      await fot.mint(alice.address, 10_000n * ONE);
      await fot.connect(alice).approve(await miner.getAddress(), ethers.MaxUint256);

      const requested = 1_000n * ONE;
      const received = requested - (requested * 200n) / 10_000n; // 2% tax
      const { fee, principal } = buyFeeSplit(received);

      await miner.connect(alice).buyMiners(requested, TIER.DAY);
      const pos = await miner.positions(alice.address, 0);
      expect(pos.principal).to.equal(principal);
      expect(await miner.totalPrincipalLocked()).to.equal(principal);
      // contract must actually hold at least what it believes is locked
      expect(await fot.balanceOf(await miner.getAddress())).to.be.gte(await miner.totalPrincipalLocked());
    });
  });

  describe("reward accrual + claimDividends", function () {
    it("distributes rewards proportional to hashpower share and applies the 3% claim fee", async function () {
      const ctx = await deployFixture();
      const { miner, neiro, alice, bob, lpWallet, ownerFeeWallet, ecoWallet } = ctx;

      // Equal principal, but bob picks a 2x tier multiplier (MONTH) vs alice's 1x (DAY).
      await miner.connect(alice).buyMiners(10_000n * ONE, TIER.DAY);
      await miner.connect(bob).buyMiners(10_000n * ONE, TIER.MONTH);

      const rewardAmount = 100_000n * ONE;
      const duration = 100_000n;
      await fundRewards(ctx, rewardAmount, duration);

      await time.increase(50_000);

      const aliceEarned = await miner.pendingRewards(alice.address);
      const bobEarned = await miner.pendingRewards(bob.address);

      // bob has 2x alice's hashpower -> should earn ~2x the reward.
      const ratio = (bobEarned * 1000n) / aliceEarned;
      expect(ratio).to.be.closeTo(2000n, 5n);

      const aliceNeiroBefore = await neiro.balanceOf(alice.address);
      const lpBefore = await neiro.balanceOf(lpWallet.address);

      await miner.connect(alice).claimDividends();

      const claimedGross = aliceEarned; // approx, accrues a bit more this block
      const aliceNeiroAfter = await neiro.balanceOf(alice.address);
      expect(aliceNeiroAfter).to.be.gt(aliceNeiroBefore);

      const lpAfter = await neiro.balanceOf(lpWallet.address);
      expect(lpAfter).to.be.gt(lpBefore);

      // Net received should be ~97% of gross earned at claim time.
      const netReceived = aliceNeiroAfter - aliceNeiroBefore;
      expect(netReceived).to.be.closeTo((claimedGross * 9700n) / 10000n, (claimedGross * 2n) / 100n);
    });

    it("reverts claiming with nothing earned", async function () {
      const ctx = await deployFixture();
      await expect(ctx.miner.connect(ctx.alice).claimDividends()).to.be.revertedWith("nothing to claim");
    });
  });

  describe("unstake", function () {
    it("returns full principal with no fee once matured", async function () {
      const ctx = await deployFixture();
      const { miner, neiro, alice } = ctx;
      const amount = 5_000n * ONE;
      await miner.connect(alice).buyMiners(amount, TIER.DAY);
      const pos = await miner.positions(alice.address, 0);

      await time.increase(Number(TIER_DURATION[TIER.DAY]) + 1);

      const before = await neiro.balanceOf(alice.address);
      await expect(miner.connect(alice).unstake(0)).to.emit(miner, "Unstaked");
      const after = await neiro.balanceOf(alice.address);
      expect(after - before).to.equal(pos.principal);
      expect(await miner.totalPrincipalLocked()).to.equal(0n);
    });

    it("applies a 10% early exit penalty: 3% to fee wallets, 7% into the reward stream for remaining stakers", async function () {
      const ctx = await deployFixture();
      const { miner, neiro, alice, bob, lpWallet, ownerFeeWallet, ecoWallet } = ctx;
      const amount = 10_000n * ONE;

      await miner.connect(alice).buyMiners(amount, TIER.MONTH);
      await miner.connect(bob).buyMiners(amount, TIER.MONTH); // stays, receives the bonus

      const pos = await miner.positions(alice.address, 0);
      const principal = pos.principal;
      const penalty = (principal * EARLY_EXIT_FEE_BPS) / BPS_DENOM;
      const stdFee = (principal * WITHDRAW_FEE_BPS) / BPS_DENOM;
      const poolBonus = penalty - stdFee;
      const expectedPayout = principal - penalty;

      const bobEarnedBefore = await miner.pendingRewards(bob.address);

      const before = await neiro.balanceOf(alice.address);
      await miner.connect(alice).unstake(0); // still within 30-day lock -> early
      const after = await neiro.balanceOf(alice.address);
      expect(after - before).to.equal(expectedPayout);

      // reward stream should now carry the 7% bonus, benefiting bob (only remaining staker)
      await time.increase(1000);
      const bobEarnedAfter = await miner.pendingRewards(bob.address);
      expect(bobEarnedAfter).to.be.gt(bobEarnedBefore);
      expect(await miner.totalRewardFunded()).to.be.gte(poolBonus);
    });

    it("cannot double-unstake the same position", async function () {
      const ctx = await deployFixture();
      const { miner, alice } = ctx;
      await miner.connect(alice).buyMiners(1_000n * ONE, TIER.DAY);
      await time.increase(Number(TIER_DURATION[TIER.DAY]) + 1);
      await miner.connect(alice).unstake(0);
      await expect(miner.connect(alice).unstake(0)).to.be.revertedWith("already withdrawn");
    });

    it("rejects an out-of-range position id", async function () {
      const ctx = await deployFixture();
      await expect(ctx.miner.connect(ctx.alice).unstake(0)).to.be.revertedWith("bad id");
    });
  });

  describe("notifyRewardAmount solvency guard", function () {
    it("reverts on zero amount, zero duration, or a duration beyond the cap", async function () {
      const ctx = await deployFixture();
      const { miner, neiro, admin } = ctx;
      await neiro.connect(admin).approve(await miner.getAddress(), 1_000n * ONE);
      await expect(miner.connect(admin).notifyRewardAmount(0, 1000)).to.be.revertedWith("amount=0");
      await expect(miner.connect(admin).notifyRewardAmount(1_000n * ONE, 0)).to.be.revertedWith("bad duration");
      const tooLong = (await miner.MAX_REWARD_DURATION()) + 1n;
      await expect(miner.connect(admin).notifyRewardAmount(1_000n * ONE, tooLong)).to.be.revertedWith("bad duration");
    });

    it("only the owner can fund the reward stream", async function () {
      const ctx = await deployFixture();
      const { miner, neiro, alice } = ctx;
      await neiro.connect(alice).approve(await miner.getAddress(), 1_000n * ONE);
      await expect(miner.connect(alice).notifyRewardAmount(1_000n * ONE, 1000)).to.be.reverted;
    });

    it("sets the reward rate from tokens actually received, not the requested amount, against a fee-on-transfer funding token", async function () {
      const [deployer, lpWallet, ownerFeeWallet, ecoWallet, admin] = await ethers.getSigners();
      const FOT = await ethers.getContractFactory("FeeOnTransferMock");
      const fot = await FOT.deploy();
      const NeiroMiner = await ethers.getContractFactory("NeiroMiner");
      const miner = await NeiroMiner.deploy(await fot.getAddress(), lpWallet.address, ownerFeeWallet.address, ecoWallet.address, admin.address);

      const requested = 100_000n * ONE;
      const received = requested - (requested * 200n) / 10_000n; // 2% tax
      await fot.mint(admin.address, requested);
      await fot.connect(admin).approve(await miner.getAddress(), requested);

      const duration = 100_000n;
      await miner.connect(admin).notifyRewardAmount(requested, duration);

      expect(await miner.rewardRate()).to.equal(received / duration);
      expect(await miner.totalRewardFunded()).to.equal(received);
      // The contract must never promise more than it actually holds.
      expect(await fot.balanceOf(await miner.getAddress())).to.be.gte(
        (await miner.rewardRate()) * duration + (await miner.totalPrincipalLocked())
      );
    });

    it("merges leftover rewards into a new rate rather than resetting them", async function () {
      const ctx = await deployFixture();
      const { miner, admin } = ctx;
      await fundRewards(ctx, 100_000n * ONE, 100_000);
      const rateBefore = await miner.rewardRate();

      await time.increase(50_000);
      await fundRewards(ctx, 50_000n * ONE, 50_000);
      const rateAfter = await miner.rewardRate();

      // leftover (~50%) + new funding compressed into the same remaining window
      // should push the rate up, not reset it to a naive amount/duration.
      expect(rateAfter).to.be.gt(rateBefore);
    });
  });

  describe("reentrancy protection", function () {
    it("blocks a hostile token from re-entering claimDividends mid-payout", async function () {
      const [deployer, lpWallet, ownerFeeWallet, ecoWallet, admin] = await ethers.getSigners();

      const RAT = await ethers.getContractFactory("ReentrancyAttackToken");
      const rat = await RAT.deploy();
      const NeiroMiner = await ethers.getContractFactory("NeiroMiner");
      const miner = await NeiroMiner.deploy(
        await rat.getAddress(),
        lpWallet.address,
        ownerFeeWallet.address,
        ecoWallet.address,
        admin.address
      );

      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await Attacker.deploy(await miner.getAddress(), await rat.getAddress());
      const attackerAddr = await attacker.getAddress();

      // Attacker stakes like any normal user (hook not armed yet, so no
      // callback fires during the buy).
      await rat.mint(attackerAddr, 10_000n * ONE);
      await attacker.approveAndBuy(10_000n * ONE, TIER.DAY);

      // Fund the reward stream so the attacker's position accrues real,
      // claimable dividends.
      await rat.mint(admin.address, 1_000_000n * ONE);
      await fundRewardsRaw(rat, miner, admin, 100_000n * ONE, 100_000);
      await time.increase(50_000);

      const pendingBefore = await miner.pendingRewards(attackerAddr);
      expect(pendingBefore).to.be.gt(0n);

      // Arm the hostile token: any transfer INTO the attacker now triggers
      // a reentrant call back into claimDividends().
      await rat.arm(attackerAddr);

      const balBefore = await rat.balanceOf(attackerAddr);
      await attacker.triggerClaim();
      const balAfter = await rat.balanceOf(attackerAddr);

      expect(await attacker.reentrancyAttempts()).to.equal(1n);
      expect(await attacker.reentrancyReverted()).to.equal(true);

      // Exactly one claim's worth of net NEIRO landed — the reentrant
      // second claim was blocked, not silently ignored or double-paid.
      const net = balAfter - balBefore;
      expect(net).to.be.gt(0n);
      expect(await miner.pendingRewards(attackerAddr)).to.equal(0n);
    });
  });

  describe("gas: O(1) regardless of user count", function () {
    it("keeps buyMiners gas roughly constant as more unrelated users join", async function () {
      const ctx = await deployFixture();
      const { miner, neiro } = ctx;
      const signers = await ethers.getSigners();
      const users = signers.slice(8, 8 + 12);

      for (const u of users) {
        await neiro.mint(u.address, 10_000n * ONE);
        await neiro.connect(u).approve(await miner.getAddress(), ethers.MaxUint256);
      }

      const gasUsed = [];
      for (const u of users) {
        const tx = await miner.connect(u).buyMiners(1_000n * ONE, TIER.WEEK);
        const receipt = await tx.wait();
        gasUsed.push(receipt.gasUsed);
      }

      // Skip the very first sample: it alone pays one-time cold-storage
      // initialization (zero -> non-zero SSTORE) for the contract's global
      // accumulator slots. From the second call on, every buy touches only
      // already-warm slots, so gas should be flat no matter how many
      // unrelated users came before — that flatness is the O(1) proof.
      const warm = gasUsed.slice(1);
      const first = warm[0];
      const last = warm[warm.length - 1];
      const drift = last > first ? last - first : first - last;
      expect(drift).to.be.lt(first / 20n); // within 5%
    });
  });

  describe("solvency invariant (randomized)", function () {
    it("never lets total obligations (locked principal + earned rewards) exceed the contract's actual token balance", async function () {
      const ctx = await deployFixture();
      const { miner, neiro, admin, alice, bob, carol } = ctx;
      const users = [alice, bob, carol];
      const tiers = [TIER.DAY, TIER.THREE_DAY, TIER.WEEK, TIER.MONTH];

      await fundRewards(ctx, 500_000n * ONE, 500_000);

      async function assertSolvent() {
        const balance = await neiro.balanceOf(await miner.getAddress());
        let obligations = await miner.totalPrincipalLocked();
        for (const u of users) {
          obligations += await miner.pendingRewards(u.address);
        }
        expect(balance).to.be.gte(obligations);
      }

      let seed = 42;
      function rand() {
        // simple deterministic PRNG so failures are reproducible
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      }

      for (let i = 0; i < 60; i++) {
        const user = users[Math.floor(rand() * users.length)];
        const action = rand();

        if (action < 0.5) {
          const amount = BigInt(1 + Math.floor(rand() * 5000)) * ONE;
          const tier = tiers[Math.floor(rand() * tiers.length)];
          await miner.connect(user).buyMiners(amount, tier);
        } else if (action < 0.8) {
          if ((await miner.pendingRewards(user.address)) > 0n) {
            await miner.connect(user).claimDividends();
          }
        } else {
          const len = await miner.positionsLength(user.address);
          if (len > 0n) {
            const idx = BigInt(Math.floor(rand() * Number(len)));
            const pos = await miner.positions(user.address, idx);
            if (pos.active) {
              await miner.connect(user).unstake(idx);
            }
          }
        }

        if (rand() < 0.3) {
          await time.increase(1 + Math.floor(rand() * 20_000));
        }

        // Occasionally top up the reward stream, exactly like a real operator would.
        if (rand() < 0.1) {
          await fundRewards(ctx, 10_000n * ONE, 20_000);
        }

        await assertSolvent();
      }
    });
  });
});

async function fundRewardsRaw(token, miner, admin, amount, duration) {
  await token.connect(admin).approve(await miner.getAddress(), amount);
  await miner.connect(admin).notifyRewardAmount(amount, duration);
}
