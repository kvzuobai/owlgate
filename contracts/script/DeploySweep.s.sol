// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {OwlSweep} from "../src/OwlSweep.sol";

/// FOUNDER-ONLY. Dry-run: forge script script/DeploySweep.s.sol --fork-url https://bsc-dataseed.bnbchain.org
/// Real deploy needs your own signer (--ledger / --interactive); never put a private key in this repo.
/// No constructor owner: OwlSweep has no admin. Router is the live TsdRouter.
contract DeploySweep is Script {
    address constant ROUTER = 0x8CF613755E9b39fa1c668A1d94aa72eDF512814f;

    function run() external {
        vm.startBroadcast();
        OwlSweep s = new OwlSweep(ROUTER);
        vm.stopBroadcast();
        console2.log("OwlSweep", address(s));
    }
}
