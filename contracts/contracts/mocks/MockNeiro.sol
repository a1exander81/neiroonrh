// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Simple mintable ERC20 standing in for $NEIRO in tests.
contract MockNeiro is ERC20 {
    constructor() ERC20("Mock Neiro", "mNEIRO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
