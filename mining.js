(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Config — fill MINER_ADDRESS in after running contracts/scripts/deploy.js
  // ---------------------------------------------------------------------
  const NEIRO_TOKEN_ADDRESS = "0x00aF23339838240bA3bb42E424936B521d31041f";
  const MINER_ADDRESS = "0xE88403a8981933fFCe41085513Ae7dd7F78d37C1";
  const ROBINHOOD_CHAIN_ID = "0x1237";
  const ROBINHOOD_CHAIN_PARAMS = {
    chainId: ROBINHOOD_CHAIN_ID,
    chainName: "Robinhood Chain",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
  };

  const BPS_DENOM = 10000;
  const BUY_FEE_BPS = 300;
  const WITHDRAW_FEE_BPS = 300;
  const EARLY_EXIT_FEE_BPS = 1000;
  const TIER_LABELS = ["24 Hours", "3 Days", "1 Week", "1 Month"];
  const TIER_DURATION_SEC = [86400, 3 * 86400, 7 * 86400, 30 * 86400];
  const TIER_MULT_BPS = [10000, 12000, 15000, 20000];

  const MINER_ABI = [
    "function buyMiners(uint256 amount, uint8 tier)",
    "function claimDividends()",
    "function unstake(uint256 positionId)",
    "function positions(address,uint256) view returns (uint256 principal, uint256 hashpower, uint64 unlockTime, uint8 tier, bool active)",
    "function positionsLength(address) view returns (uint256)",
    "function pendingRewards(address) view returns (uint256)",
    "function tierInfo(uint8) view returns (uint64 duration, uint256 multiplierBps)",
    "function totalHashpower() view returns (uint256)",
    "function totalPrincipalLocked() view returns (uint256)",
    "function rewardRate() view returns (uint256)",
    "function rewardPeriodFinish() view returns (uint256)",
    "function paused() view returns (bool)",
  ];
  const TOKEN_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
  ];

  const el = (id) => document.getElementById(id);
  const connectBtns = Array.from(document.querySelectorAll("[data-connect-wallet]"));
  const buyBtn = el("buyBtn");
  const claimBtn = el("claimBtn");
  const amountInput = el("buyAmount");
  const maxBtn = el("maxBtn");
  const tierPicker = el("tierPicker");
  const positionsList = el("positionsList");
  const notDeployedBanner = el("notDeployedBanner");
  const contractAddrEl = el("contractAddr");

  const provider = window.ethereum ? new ethers.providers.Web3Provider(window.ethereum, "any") : null;
  let signer = null;
  let userAddress = null;
  let tokenDecimals = 18;
  let selectedTier = 0;

  const hasContract = MINER_ADDRESS && MINER_ADDRESS.length === 42;

  function fmt(bnOrNum, decimals) {
    try {
      return parseFloat(ethers.utils.formatUnits(bnOrNum, decimals ?? tokenDecimals)).toLocaleString(undefined, {
        maximumFractionDigits: 4,
      });
    } catch (e) {
      return "0.00";
    }
  }

  function formatAddress(address) {
    if (!address) return "Not connected";
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
  }

  function setConnectLabel(label) {
    connectBtns.forEach((b) => (b.textContent = label));
  }

  if (hasContract && contractAddrEl) {
    contractAddrEl.textContent = MINER_ADDRESS;
  }
  if (notDeployedBanner && hasContract) {
    notDeployedBanner.classList.add("hidden");
  }

  // ---------------------------------------------------------------------
  // Chain + wallet
  // ---------------------------------------------------------------------
  async function ensureRobinhoodChain() {
    if (!window.ethereum || !provider) return false;
    try {
      const network = await provider.getNetwork();
      if (network.chainId === 4663) return true;
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ROBINHOOD_CHAIN_ID }] });
      return true;
    } catch (err) {
      try {
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [ROBINHOOD_CHAIN_PARAMS] });
        return true;
      } catch (addErr) {
        console.error("Robinhood chain setup failed", addErr);
        return false;
      }
    }
  }

  async function connectWallet() {
    if (!window.ethereum) {
      alert("No EVM wallet found. Install MetaMask, Rabby, or another compatible wallet.");
      return;
    }
    try {
      await provider.send("eth_requestAccounts", []);
      await ensureRobinhoodChain();
      signer = provider.getSigner();
      userAddress = await signer.getAddress();
      setConnectLabel(formatAddress(userAddress));
      el("statWallet").textContent = formatAddress(userAddress);
      await refreshAll();
    } catch (err) {
      console.error("Wallet connect failed", err);
    }
  }

  connectBtns.forEach((b) => b.addEventListener("click", connectWallet));
  if (window.ethereum) {
    window.ethereum.on("accountsChanged", () => window.location.reload());
    window.ethereum.on("chainChanged", () => window.location.reload());
  }

  function minerContract(withSigner) {
    if (!hasContract) return null;
    return new ethers.Contract(MINER_ADDRESS, MINER_ABI, withSigner ? signer : provider);
  }
  function tokenContract(withSigner) {
    return new ethers.Contract(NEIRO_TOKEN_ADDRESS, TOKEN_ABI, withSigner ? signer : provider);
  }

  // ---------------------------------------------------------------------
  // Tier picker + live buy breakdown
  // ---------------------------------------------------------------------
  function renderTierButtons() {
    if (!tierPicker) return;
    Array.from(tierPicker.querySelectorAll(".mine-tier")).forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedTier = parseInt(btn.dataset.tier, 10);
        Array.from(tierPicker.querySelectorAll(".mine-tier")).forEach((b) => b.classList.toggle("active", b === btn));
        updateBreakdown();
      });
    });
  }

  function updateBreakdown() {
    const raw = parseFloat(amountInput.value || "0");
    const amount = isFinite(raw) && raw > 0 ? raw : 0;
    const fee = (amount * BUY_FEE_BPS) / BPS_DENOM;
    const each = fee / 3;
    const principal = amount - fee;
    const hashpower = (principal * TIER_MULT_BPS[selectedTier]) / BPS_DENOM;

    el("bdFee").textContent = fee.toFixed(4);
    el("bdLp").textContent = each.toFixed(4);
    el("bdOwner").textContent = each.toFixed(4);
    el("bdEco").textContent = each.toFixed(4);
    el("bdPrincipal").textContent = principal.toFixed(4);
    el("bdHashpower").textContent = hashpower.toFixed(4);
  }

  if (amountInput) amountInput.addEventListener("input", updateBreakdown);
  renderTierButtons();
  updateBreakdown();

  if (maxBtn) {
    maxBtn.addEventListener("click", async () => {
      if (!userAddress) return connectWallet();
      const bal = await tokenContract(false).balanceOf(userAddress);
      amountInput.value = ethers.utils.formatUnits(bal, tokenDecimals);
      updateBreakdown();
    });
  }

  // ---------------------------------------------------------------------
  // Buy
  // ---------------------------------------------------------------------
  async function refreshBuyButton() {
    if (!userAddress) {
      buyBtn.textContent = "Connect wallet to buy";
      buyBtn.disabled = false;
      return;
    }
    if (!hasContract) {
      buyBtn.textContent = "Mining contract coming soon";
      buyBtn.disabled = true;
      return;
    }
    try {
      const paused = await minerContract(false).paused();
      if (paused) {
        buyBtn.textContent = "New miners paused";
        buyBtn.disabled = true;
        return;
      }
    } catch (e) {
      /* ignore — fall through */
    }
    buyBtn.textContent = "Buy miners";
    buyBtn.disabled = false;
  }

  if (buyBtn) {
    buyBtn.addEventListener("click", async () => {
      if (!userAddress) return connectWallet();
      if (!hasContract) return;
      const raw = amountInput.value;
      const amount = parseFloat(raw || "0");
      if (!(amount > 0)) return;

      try {
        const amountWei = ethers.utils.parseUnits(raw, tokenDecimals);
        const token = tokenContract(true);
        const allowance = await token.allowance(userAddress, MINER_ADDRESS);
        if (allowance.lt(amountWei)) {
          buyBtn.textContent = "Approving…";
          buyBtn.disabled = true;
          const tx = await token.approve(MINER_ADDRESS, ethers.constants.MaxUint256);
          await tx.wait();
        }
        buyBtn.textContent = "Confirm in wallet…";
        const miner = minerContract(true);
        const tx2 = await miner.buyMiners(amountWei, selectedTier);
        buyBtn.textContent = "Buying…";
        await tx2.wait();
        amountInput.value = "";
        updateBreakdown();
        await refreshAll();
      } catch (err) {
        console.error("Buy failed", err);
        alert(err?.reason || err?.message || "Transaction failed.");
      } finally {
        await refreshBuyButton();
      }
    });
  }

  // ---------------------------------------------------------------------
  // Claim
  // ---------------------------------------------------------------------
  async function refreshClaim() {
    if (!userAddress || !hasContract) {
      claimBtn.textContent = userAddress ? "Mining contract coming soon" : "Connect wallet to claim";
      claimBtn.disabled = !userAddress ? false : true;
      el("pendingRewards").textContent = "0.0000 $NEIRO";
      return;
    }
    try {
      const pending = await minerContract(false).pendingRewards(userAddress);
      el("pendingRewards").textContent = `${fmt(pending)} $NEIRO`;
      claimBtn.disabled = pending.isZero();
      claimBtn.textContent = pending.isZero() ? "Nothing to claim" : `Claim (−3% fee)`;
    } catch (err) {
      console.error("pendingRewards read failed", err);
    }
  }

  if (claimBtn) {
    claimBtn.addEventListener("click", async () => {
      if (!userAddress) return connectWallet();
      if (!hasContract) return;
      try {
        claimBtn.disabled = true;
        claimBtn.textContent = "Confirm in wallet…";
        const tx = await minerContract(true).claimDividends();
        await tx.wait();
        await refreshAll();
      } catch (err) {
        console.error("Claim failed", err);
        alert(err?.reason || err?.message || "Transaction failed.");
      } finally {
        await refreshClaim();
      }
    });
  }

  // ---------------------------------------------------------------------
  // Positions list
  // ---------------------------------------------------------------------
  function countdown(unlockTime) {
    const now = Math.floor(Date.now() / 1000);
    const diff = unlockTime - now;
    if (diff <= 0) return "Matured";
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    const m = Math.floor((diff % 3600) / 60);
    if (d > 0) return `${d}d ${h}h left`;
    if (h > 0) return `${h}h ${m}m left`;
    return `${m}m left`;
  }

  async function renderPositions() {
    if (!positionsList) return;
    if (!userAddress) {
      positionsList.innerHTML = `<div class="mine-empty">Connect your wallet to see your miner positions.</div>`;
      return;
    }
    if (!hasContract) {
      positionsList.innerHTML = `<div class="mine-empty">Mining contract isn't deployed on this build yet.</div>`;
      return;
    }
    try {
      const miner = minerContract(false);
      const len = (await miner.positionsLength(userAddress)).toNumber();
      if (len === 0) {
        positionsList.innerHTML = `<div class="mine-empty">No miners yet — buy your first one above.</div>`;
        return;
      }
      const rows = [];
      for (let i = 0; i < len; i++) {
        const pos = await miner.positions(userAddress, i);
        if (!pos.active) continue;
        const unlockTime = pos.unlockTime.toNumber ? pos.unlockTime.toNumber() : Number(pos.unlockTime);
        const matured = Math.floor(Date.now() / 1000) >= unlockTime;
        rows.push(`
          <div class="mine-position">
            <div class="pp-main">
              <div class="pp-amount">${fmt(pos.principal)} $NEIRO</div>
              <div class="pp-meta">${TIER_LABELS[pos.tier]} · hashpower ${fmt(pos.hashpower)} · ${countdown(unlockTime)}</div>
            </div>
            <div class="pp-status ${matured ? "matured" : "locked"}">${matured ? "Matured" : "Locked"}</div>
            <div class="pp-actions">
              <button data-unstake="${i}" data-early="${!matured}">${matured ? "Unstake" : "Unstake early (−10%)"}</button>
            </div>
          </div>
        `);
      }
      positionsList.innerHTML = rows.length
        ? rows.join("")
        : `<div class="mine-empty">No active miners — buy your first one above.</div>`;

      Array.from(positionsList.querySelectorAll("[data-unstake]")).forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = parseInt(btn.dataset.unstake, 10);
          const early = btn.dataset.early === "true";
          if (early && !confirm("This position hasn't matured yet. Unstaking now costs a 10% early-exit penalty. Continue?")) {
            return;
          }
          try {
            btn.disabled = true;
            btn.textContent = "Confirm in wallet…";
            const tx = await minerContract(true).unstake(id);
            await tx.wait();
            await refreshAll();
          } catch (err) {
            console.error("Unstake failed", err);
            alert(err?.reason || err?.message || "Transaction failed.");
            await renderPositions();
          }
        });
      });
    } catch (err) {
      console.error("renderPositions failed", err);
      positionsList.innerHTML = `<div class="mine-empty">Couldn't load your positions. Check you're on Robinhood Chain.</div>`;
    }
  }

  // ---------------------------------------------------------------------
  // Stats strip
  // ---------------------------------------------------------------------
  async function refreshStats() {
    if (!hasContract) {
      el("statTVL").textContent = "—";
      el("statHashpower").textContent = "—";
      el("statRewardRate").textContent = "—";
      return;
    }
    try {
      const miner = minerContract(false);
      const [tvl, hashpower, rate, finish] = await Promise.all([
        miner.totalPrincipalLocked(),
        miner.totalHashpower(),
        miner.rewardRate(),
        miner.rewardPeriodFinish(),
      ]);
      el("statTVL").textContent = `${fmt(tvl)} $NEIRO`;
      el("statHashpower").textContent = fmt(hashpower);
      const finishNum = finish.toNumber ? finish.toNumber() : Number(finish);
      const active = finishNum > Math.floor(Date.now() / 1000);
      el("statRewardRate").textContent = active ? `${fmt(rate.mul(86400))} $NEIRO/day` : "No active stream";
    } catch (err) {
      console.error("refreshStats failed", err);
    }
  }

  async function refreshAll() {
    if (userAddress && hasContract) {
      try {
        tokenDecimals = await tokenContract(false).decimals();
        const bal = await tokenContract(false).balanceOf(userAddress);
        el("statWallet").textContent = `${formatAddress(userAddress)} · ${fmt(bal)} $NEIRO`;
      } catch (e) {
        /* ignore */
      }
    }
    await Promise.all([refreshStats(), refreshClaim(), renderPositions(), refreshBuyButton()]);
  }

  refreshStats();
  refreshBuyButton();
  refreshClaim();
  renderPositions();

  // Keep countdowns fresh without re-hitting the chain every tick.
  setInterval(() => {
    if (userAddress && hasContract) renderPositions();
  }, 60000);
})();
