// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TsdRouter} from "../src/TsdRouter.sol";
import {OwlSweep} from "../src/OwlSweep.sol";
import {MockNFT, MockCMKT} from "./Mocks.sol";

/// Buyer that tries to re-enter OwlSweep during its refund.
contract ReenterSweeper {
    OwlSweep public s;
    bool public reverted;

    function go(OwlSweep s_, uint256[] calldata ids, uint96[] calldata px) external payable {
        s = s_;
        s.buyMany{value: msg.value}(ids, px, 0);
    }

    receive() external payable {
        if (msg.sender != address(s)) return;
        uint256[] memory ids = new uint256[](1);
        uint96[] memory px = new uint96[](1);
        try s.buyMany(ids, px, 0) {} catch { reverted = true; }
    }
}

contract OwlSweepTest is Test {
    TsdRouter r;
    OwlSweep s;
    MockCMKT m;
    MockNFT nft;
    address owner = address(0xF00D);
    address feeTo = address(0xFEE);
    address seller = address(0x5E11);
    address alice = address(0xA11CE);

    function setUp() public {
        m = new MockCMKT();
        nft = new MockNFT();
        r = new TsdRouter(address(m), owner, feeTo);
        s = new OwlSweep(address(r));
        vm.deal(alice, 1000 ether);
        m.list(1, seller, address(nft), 1 ether, 1001);
        m.list(2, seller, address(nft), 2 ether, 1002);
        m.list(3, seller, address(nft), 3 ether, 1003);
    }

    function _args(uint256 n) internal pure returns (uint256[] memory ids, uint96[] memory px) {
        ids = new uint256[](n);
        px = new uint96[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = i + 1;
            px[i] = uint96((i + 1) * 1 ether);
        }
    }

    function test_sweep_three_one_tx() public {
        (uint256[] memory ids, uint96[] memory px) = _args(3);
        assertEq(s.quoteMany(px), 6.06 ether);
        vm.prank(alice);
        s.buyMany{value: 6.06 ether}(ids, px, 3);
        assertEq(nft.ownerOf(1001), alice);
        assertEq(nft.ownerOf(1002), alice);
        assertEq(nft.ownerOf(1003), alice);
        assertEq(feeTo.balance, 0.06 ether);
        assertEq(alice.balance, 1000 ether - 6.06 ether);
        assertEq(address(s).balance, 0);
        assertEq(address(r).balance, 0);
    }

    function test_overpay_refunded() public {
        (uint256[] memory ids, uint96[] memory px) = _args(2);
        vm.prank(alice);
        s.buyMany{value: 10 ether}(ids, px, 0);
        assertEq(alice.balance, 1000 ether - 3.03 ether);
        assertEq(address(s).balance, 0);
    }

    function test_sold_listing_skipped_and_refunded() public {
        vm.prank(alice);
        r.buy{value: 2.02 ether}(2, 2 ether); // someone takes #2 first
        (uint256[] memory ids, uint96[] memory px) = _args(3);
        address bob = address(0xB0B);
        vm.deal(bob, 10 ether);
        vm.prank(bob);
        s.buyMany{value: 6.06 ether}(ids, px, 1);
        assertEq(nft.ownerOf(1001), bob);
        assertEq(nft.ownerOf(1002), alice);
        assertEq(nft.ownerOf(1003), bob);
        assertEq(bob.balance, 10 ether - 4.04 ether);
        assertEq(address(s).balance, 0);
    }

    function test_repriced_listing_skipped() public {
        m.list(2, seller, address(nft), 2.5 ether, 1002);
        (uint256[] memory ids, uint96[] memory px) = _args(3);
        vm.prank(alice);
        s.buyMany{value: 6.06 ether}(ids, px, 0);
        assertEq(nft.ownerOf(1002), address(m));
        assertEq(alice.balance, 1000 ether - 4.04 ether);
    }

    function test_min_filled_reverts_all() public {
        vm.prank(alice);
        r.buy{value: 2.02 ether}(2, 2 ether);
        (uint256[] memory ids, uint96[] memory px) = _args(3);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwlSweep.TooFewFilled.selector, 2));
        s.buyMany{value: 6.06 ether}(ids, px, 3);
        assertEq(nft.ownerOf(1001), address(m));
    }

    function test_underpaid_buys_what_fits() public {
        (uint256[] memory ids, uint96[] memory px) = _args(3);
        vm.prank(alice);
        s.buyMany{value: 3.5 ether}(ids, px, 0); // fits #1 + #2 (3.03), not #3
        assertEq(nft.ownerOf(1001), alice);
        assertEq(nft.ownerOf(1002), alice);
        assertEq(nft.ownerOf(1003), address(m));
        assertEq(alice.balance, 1000 ether - 3.03 ether);
    }

    function test_paused_router_skips_all() public {
        vm.prank(owner);
        r.setPaused(true);
        (uint256[] memory ids, uint96[] memory px) = _args(2);
        vm.prank(alice);
        s.buyMany{value: 3.03 ether}(ids, px, 0);
        assertEq(alice.balance, 1000 ether);
    }

    function test_bad_length() public {
        uint256[] memory ids = new uint256[](21);
        uint96[] memory px = new uint96[](21);
        vm.expectRevert(OwlSweep.BadLength.selector);
        s.buyMany(ids, px, 0);
        vm.expectRevert(OwlSweep.BadLength.selector);
        s.buyMany(new uint256[](2), new uint96[](1), 0);
        vm.expectRevert(OwlSweep.BadLength.selector);
        s.buyMany(new uint256[](0), new uint96[](0), 0);
    }

    function test_rejects_plain_bnb() public {
        vm.prank(alice);
        (bool ok,) = address(s).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_reentry_on_refund_blocked() public {
        ReenterSweeper b = new ReenterSweeper();
        vm.deal(address(b), 0);
        (uint256[] memory ids, uint96[] memory px) = _args(1);
        b.go{value: 2 ether}(s, ids, px);
        assertTrue(b.reverted());
        assertEq(nft.ownerOf(1001), address(b));
        assertEq(address(s).balance, 0);
    }

    function testFuzz_never_keeps_balance(uint8 n, uint96 extra) public {
        n = uint8(bound(n, 1, 3));
        (uint256[] memory ids, uint96[] memory px) = _args(n);
        uint256 v = s.quoteMany(px) + uint256(extra) % 5 ether;
        vm.prank(alice);
        s.buyMany{value: v}(ids, px, n);
        assertEq(address(s).balance, 0);
        assertEq(address(r).balance, 0);
    }
}
