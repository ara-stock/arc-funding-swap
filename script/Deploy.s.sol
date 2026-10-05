// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {FundingIndexOracle} from "../src/FundingIndexOracle.sol";
import {FundingRateSwap, IERC20} from "../src/FundingRateSwap.sol";

/// Deploys the oracle and the swap on Arc mainnet.
///
///   PUBLISHER=0x... forge script script/Deploy.s.sol --rpc-url arc --account <keystore> --broadcast
///
/// PUBLISHER is the address allowed to post funding values. It is the publisher keystore's
/// address and can differ from the deployer.
contract Deploy is Script {
    IERC20 constant ARC_USDC = IERC20(0x3600000000000000000000000000000000000000); // 6-decimal ERC-20 interface

    function run() external {
        address publisher = vm.envAddress("PUBLISHER");
        require(block.chainid == 5042, "not Arc mainnet");
        vm.startBroadcast();
        FundingIndexOracle oracle = new FundingIndexOracle(publisher);
        FundingRateSwap swap = new FundingRateSwap(ARC_USDC, oracle);
        vm.stopBroadcast();
        console.log("FundingIndexOracle", address(oracle));
        console.log("FundingRateSwap   ", address(swap));
    }
}
