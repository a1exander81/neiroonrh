// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IReentrancyHook {
    function onTokenTransfer() external;
}

/// @notice Hostile ERC20 that calls back into an attacker contract on every
///         outbound transfer, simulating a hook-bearing token (e.g. ERC777)
///         so NeiroMiner's ReentrancyGuard can be proven effective even
///         though real $NEIRO is a plain ERC20 with no such hook.
contract ReentrancyAttackToken is ERC20 {
    address public hookTarget;
    bool public armed;

    constructor() ERC20("Reentrancy Attack Token", "RAT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target) external {
        hookTarget = target;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && to == hookTarget) {
            IReentrancyHook(hookTarget).onTokenTransfer();
        }
    }
}
