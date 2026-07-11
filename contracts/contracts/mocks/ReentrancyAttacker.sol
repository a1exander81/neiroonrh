// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface INeiroMinerForAttack {
    function claimDividends() external;
    function unstake(uint256 positionId) external;
    function buyMiners(uint256 amount, uint8 tier) external;
}

interface IERC20ForAttack {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Attempts to re-enter NeiroMiner mid-payout via a hostile token
///         hook. Used only in tests to prove ReentrancyGuard blocks it.
contract ReentrancyAttacker {
    INeiroMinerForAttack public immutable miner;
    IERC20ForAttack public immutable token;
    uint256 public reentrancyAttempts;
    bool public reentrancyReverted;

    constructor(address minerAddress, address tokenAddress) {
        miner = INeiroMinerForAttack(minerAddress);
        token = IERC20ForAttack(tokenAddress);
    }

    function approveAndBuy(uint256 amount, uint8 tier) external {
        token.approve(address(miner), amount);
        miner.buyMiners(amount, tier);
    }

    function triggerClaim() external {
        miner.claimDividends();
    }

    function triggerUnstake(uint256 positionId) external {
        miner.unstake(positionId);
    }

    // Called by the hostile token during the outbound transfer that pays
    // this contract its dividends/principal.
    function onTokenTransfer() external {
        reentrancyAttempts += 1;
        try miner.claimDividends() {
            // If this succeeds, the guard failed to stop re-entry.
        } catch {
            reentrancyReverted = true;
        }
    }
}
