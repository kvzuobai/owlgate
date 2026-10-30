// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {OwlSweep, INft, IMarketView} from "../src/OwlSweep.sol";

/// forge test --match-contract OwlSweepFork --fork-url https://bsc-dataseed.bnbchain.org
/// LIDS / PXS env = live cmkt listing ids and prices (wei), comma separated.
contract OwlSweepFork is Test {
    address constant ROUTER = 0x8CF613755E9b39fa1c668A1d94aa72eDF512814f;

    function test_fork_sweep_live_listings() public {
        if (block.chainid != 56) return;
        uint256[] memory ids = vm.envUint("LIDS", ",");
        uint256[] memory raw = vm.envUint("PXS", ",");
        uint96[] memory px = new uint96[](raw.length);
        for (uint256 i; i < raw.length; ++i) px[i] = uint96(raw[i]);

        OwlSweep s = new OwlSweep(ROUTER);
        IMarketView m = s.market();
        address[] memory nfts = new address[](ids.length);
        uint256[] memory tids = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) (, nfts[i],,, tids[i]) = m.listings(ids[i]);

        address buyer = makeAddr("buyer");
        uint256 v = s.quoteMany(px);
        vm.deal(buyer, v + 1 ether);
        vm.prank(buyer);
        s.buyMany{value: v + 1 ether}(ids, px, ids.length);

        for (uint256 i; i < ids.length; ++i) assertEq(INft(nfts[i]).ownerOf(tids[i]), buyer);
        assertEq(buyer.balance, 1 ether); // spent exactly the quote
        assertEq(address(s).balance, 0);
        assertEq(ROUTER.balance, 0);
    }
}
