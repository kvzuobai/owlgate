// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TsdRouter} from "../src/TsdRouter.sol";

/// FOUNDER-ONLY, NOT RUN BY ENGINEER. Dry-run: forge script script/Deploy.s.sol --fork-url $BSC_RPC
/// Real deploy needs your own signer (hardware wallet / --ledger); never put a private key in this repo.
/// env: OWNER (founder/multisig). feeRecipient is hard-set to the founder fee wallet; CMKT is fixed below.
contract Deploy is Script {
    address constant CMKT = 0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f;

    function run() external {
        address owner = vm.envAddress("OWNER");
        address feeRecipient = 0x58f341EBF80ab52D7650750119e8641cFBC8C018; // founder fee wallet (s8)
        vm.startBroadcast();
        TsdRouter r = new TsdRouter(CMKT, owner, feeRecipient);
        vm.stopBroadcast();
        console2.log("TsdRouter", address(r));
    }
}
