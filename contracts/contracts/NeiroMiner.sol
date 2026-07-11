// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title NeiroMiner
/// @notice Lock $NEIRO into a chosen tier ("buy miners") and earn a share of a
///         capped, owner-funded reward stream. Yield is bounded by tokens the
///         contract actually holds — it is never funded by other users' deposits.
///
/// Design notes (why it's shaped this way):
/// - Reward accounting uses the Synthetix StakingRewards accumulator pattern:
///   O(1) gas per buy/claim/unstake regardless of how many users exist, so the
///   contract cannot be gas-DoS'd by growing a user base ("no clogging").
/// - The contract is intentionally not upgradeable and has no owner sweep
///   function over user principal or the reward pool — the owner can only add
///   funds (notifyRewardAmount) and pause *new* deposits, never touch what's
///   already deposited or promised. This removes the classic rug-pull lever.
/// - Fee wallets are immutable constructor args, not owner-settable, so fee
///   routing can't be redirected after launch.
/// - Buy/claim pull amounts are measured by actual balance delta, not the
///   requested amount, so a fee-on-transfer or deflationary token behavior
///   never desyncs internal accounting from real holdings.
contract NeiroMiner is ReentrancyGuard, Pausable, Ownable2Step {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Tier {
        DAY, // 24 hours
        THREE_DAY, // 3 days
        WEEK, // 1 week
        MONTH // 30 days
    }

    struct Position {
        uint256 principal; // net NEIRO locked (post buy-fee)
        uint256 hashpower; // principal * tier multiplier, drives reward share
        uint64 unlockTime;
        Tier tier;
        bool active;
    }

    // ---------------------------------------------------------------------
    // Immutable configuration
    // ---------------------------------------------------------------------

    IERC20 public immutable neiro;
    address public immutable lpWallet;
    address public immutable ownerFeeWallet;
    address public immutable ecoWallet;

    uint256 public constant BPS_DENOM = 10_000;
    uint256 public constant BUY_FEE_BPS = 300; // 3%
    uint256 public constant WITHDRAW_FEE_BPS = 300; // 3%
    uint256 public constant EARLY_EXIT_FEE_BPS = 1_000; // 10%
    uint256 public constant FEE_SHARE_BPS = 100; // 1% to each of LP / owner / eco

    uint256 public constant MAX_REWARD_DURATION = 180 days;
    uint256 public constant EARLY_EXIT_BONUS_DEFAULT_DURATION = 1 days;

    uint64[4] internal _tierDuration = [uint64(1 days), uint64(3 days), uint64(7 days), uint64(30 days)];
    // basis points, 10_000 = 1.00x
    uint256[4] internal _tierMultiplierBps = [uint256(10_000), 12_000, 15_000, 20_000];

    // ---------------------------------------------------------------------
    // Reward stream state (Synthetix-style accumulator)
    // ---------------------------------------------------------------------

    uint256 public rewardRate; // NEIRO per second
    uint256 public rewardPeriodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardPerHashpowerStored; // scaled by 1e18

    mapping(address => uint256) public userRewardPerHashpowerPaid;
    mapping(address => uint256) public rewards; // accrued, unclaimed NEIRO (gross, pre-fee)
    mapping(address => uint256) public userHashpower;

    uint256 public totalHashpower;
    uint256 public totalPrincipalLocked;
    uint256 public totalRewardFunded; // lifetime, for transparency
    uint256 public totalRewardClaimed; // lifetime gross claimed

    mapping(address => Position[]) public positions;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event MinerPurchased(
        address indexed user,
        uint256 indexed positionId,
        uint256 grossAmount,
        uint256 fee,
        uint256 principal,
        uint256 hashpower,
        Tier tier,
        uint64 unlockTime
    );
    event DividendsClaimed(address indexed user, uint256 gross, uint256 fee, uint256 net);
    event Unstaked(
        address indexed user, uint256 indexed positionId, uint256 principal, uint256 fee, uint256 payout, bool early
    );
    event RewardFunded(address indexed funder, uint256 amount, uint256 duration, uint256 newRate);
    event EarlyExitBonusInjected(uint256 amount, uint256 newRate, uint256 newFinish);

    constructor(address neiroToken, address lpWallet_, address ownerFeeWallet_, address ecoWallet_, address admin)
        Ownable(admin)
    {
        require(neiroToken != address(0), "neiro=0");
        require(lpWallet_ != address(0) && ownerFeeWallet_ != address(0) && ecoWallet_ != address(0), "wallet=0");
        require(admin != address(0), "admin=0");
        neiro = IERC20(neiroToken);
        lpWallet = lpWallet_;
        ownerFeeWallet = ownerFeeWallet_;
        ecoWallet = ecoWallet_;
    }

    // ---------------------------------------------------------------------
    // Reward accumulator internals
    // ---------------------------------------------------------------------

    modifier updateReward(address account) {
        rewardPerHashpowerStored = rewardPerHashpower();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerHashpowerPaid[account] = rewardPerHashpowerStored;
        }
        _;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < rewardPeriodFinish ? block.timestamp : rewardPeriodFinish;
    }

    function rewardPerHashpower() public view returns (uint256) {
        if (totalHashpower == 0) return rewardPerHashpowerStored;
        uint256 elapsed = lastTimeRewardApplicable() - lastUpdateTime;
        return rewardPerHashpowerStored + (elapsed * rewardRate * 1e18) / totalHashpower;
    }

    function earned(address account) public view returns (uint256) {
        uint256 delta = rewardPerHashpower() - userRewardPerHashpowerPaid[account];
        return (userHashpower[account] * delta) / 1e18 + rewards[account];
    }

    // ---------------------------------------------------------------------
    // User actions
    // ---------------------------------------------------------------------

    function buyMiners(uint256 amount, Tier tier) external nonReentrant whenNotPaused updateReward(msg.sender) {
        require(amount > 0, "amount=0");

        uint256 balBefore = neiro.balanceOf(address(this));
        neiro.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = neiro.balanceOf(address(this)) - balBefore;
        require(received > 0, "nothing received");

        uint256 fee = (received * BUY_FEE_BPS) / BPS_DENOM;
        uint256 principal = received - fee;
        _distributeFee(fee);

        uint256 multiplier = _tierMultiplierBps[uint256(tier)];
        uint256 hashpower = (principal * multiplier) / BPS_DENOM;
        uint64 unlockTime = uint64(block.timestamp) + _tierDuration[uint256(tier)];

        positions[msg.sender].push(
            Position({principal: principal, hashpower: hashpower, unlockTime: unlockTime, tier: tier, active: true})
        );

        userHashpower[msg.sender] += hashpower;
        totalHashpower += hashpower;
        totalPrincipalLocked += principal;

        emit MinerPurchased(
            msg.sender, positions[msg.sender].length - 1, received, fee, principal, hashpower, tier, unlockTime
        );
    }

    function claimDividends() external nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        require(reward > 0, "nothing to claim");
        rewards[msg.sender] = 0;
        totalRewardClaimed += reward;

        uint256 fee = (reward * WITHDRAW_FEE_BPS) / BPS_DENOM;
        uint256 net = reward - fee;
        _distributeFee(fee);

        neiro.safeTransfer(msg.sender, net);
        emit DividendsClaimed(msg.sender, reward, fee, net);
    }

    function unstake(uint256 positionId) external nonReentrant updateReward(msg.sender) {
        require(positionId < positions[msg.sender].length, "bad id");
        Position storage pos = positions[msg.sender][positionId];
        require(pos.active, "already withdrawn");

        pos.active = false;
        userHashpower[msg.sender] -= pos.hashpower;
        totalHashpower -= pos.hashpower;
        totalPrincipalLocked -= pos.principal;

        uint256 principal = pos.principal;
        bool early = block.timestamp < pos.unlockTime;
        uint256 payout;
        uint256 fee;

        if (!early) {
            payout = principal;
        } else {
            uint256 penalty = (principal * EARLY_EXIT_FEE_BPS) / BPS_DENOM; // 10%
            fee = (principal * WITHDRAW_FEE_BPS) / BPS_DENOM; // 3% -> standard split
            uint256 poolBonus = penalty - fee; // 7% -> remaining loyal stakers
            payout = principal - penalty;
            _distributeFee(fee);
            if (poolBonus > 0) {
                if (totalHashpower > 0) {
                    _injectEarlyExitBonus(poolBonus);
                } else {
                    // No active stakers left to receive it — do not strand funds in
                    // the stream; route to the eco wallet instead.
                    neiro.safeTransfer(ecoWallet, poolBonus);
                }
            }
        }

        neiro.safeTransfer(msg.sender, payout);
        emit Unstaked(msg.sender, positionId, principal, fee, payout, early);
    }

    // ---------------------------------------------------------------------
    // Owner actions — additive only, never touches user funds
    // ---------------------------------------------------------------------

    /// @notice Fund (or extend) the reward stream. Requires prior ERC20 approval
    ///         from the caller. Enforces that the contract already holds enough
    ///         spare (non-principal) balance to back the full new rate for the
    ///         full duration, so payouts can never exceed real holdings.
    function notifyRewardAmount(uint256 amount, uint256 duration)
        external
        onlyOwner
        nonReentrant
        updateReward(address(0))
    {
        require(amount > 0, "amount=0");
        require(duration > 0 && duration <= MAX_REWARD_DURATION, "bad duration");

        uint256 balBefore = neiro.balanceOf(address(this));
        neiro.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = neiro.balanceOf(address(this)) - balBefore;
        require(received > 0, "nothing received");
        totalRewardFunded += received;

        if (block.timestamp >= rewardPeriodFinish) {
            rewardRate = received / duration;
        } else {
            uint256 remaining = rewardPeriodFinish - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (leftover + received) / duration;
        }

        uint256 freeBalance = neiro.balanceOf(address(this)) - totalPrincipalLocked;
        require(rewardRate * duration <= freeBalance, "insufficient funding for rate");

        lastUpdateTime = block.timestamp;
        rewardPeriodFinish = block.timestamp + duration;
        emit RewardFunded(msg.sender, received, duration, rewardRate);
    }

    function pauseNewMiners() external onlyOwner {
        _pause();
    }

    function unpauseNewMiners() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _distributeFee(uint256 fee) internal {
        if (fee == 0) return;
        uint256 each = fee / 3;
        uint256 remainder = fee - each * 3; // dust from integer division goes to eco wallet
        neiro.safeTransfer(lpWallet, each);
        neiro.safeTransfer(ownerFeeWallet, each);
        neiro.safeTransfer(ecoWallet, each + remainder);
    }

    function _injectEarlyExitBonus(uint256 bonusAmount) internal {
        // Tokens are already held by the contract (forfeited principal); this
        // only reclassifies them into the active reward stream.
        if (block.timestamp >= rewardPeriodFinish) {
            rewardRate = bonusAmount / EARLY_EXIT_BONUS_DEFAULT_DURATION;
            rewardPeriodFinish = block.timestamp + EARLY_EXIT_BONUS_DEFAULT_DURATION;
        } else {
            uint256 remaining = rewardPeriodFinish - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (leftover + bonusAmount) / remaining;
        }
        lastUpdateTime = block.timestamp;
        totalRewardFunded += bonusAmount;
        emit EarlyExitBonusInjected(bonusAmount, rewardRate, rewardPeriodFinish);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function positionsLength(address user) external view returns (uint256) {
        return positions[user].length;
    }

    function tierInfo(Tier tier) external view returns (uint64 duration, uint256 multiplierBps) {
        return (_tierDuration[uint256(tier)], _tierMultiplierBps[uint256(tier)]);
    }

    function pendingRewards(address user) external view returns (uint256) {
        return earned(user);
    }
}
