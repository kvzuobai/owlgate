// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TsdRouter} from "../src/TsdRouter.sol";
import {MockNFT, MockCMKT, ReenterFeeRecipient, ReenterBuyer, Rejector} from "./Mocks.sol";

contract TsdRouterTest is Test {
    TsdRouter r;
    MockCMKT m;
    MockNFT nft;
    address owner = address(0xF00D);
    address feeTo = address(0xFEE);
    address seller = address(0x5E11);
    address op = address(0x0BE4);
    address alice = address(0xA11CE);

    function setUp() public {
        m = new MockCMKT();
        nft = new MockNFT();
        r = new TsdRouter(address(m), owner, feeTo);
        vm.deal(alice, 1000 ether);
    }

    function _list(uint256 id, uint96 price) internal {
        m.list(id, seller, address(nft), price, id + 1000);
    }

    // ------------------------------------------------------------ happy path
    function test_buy_default_fee_1pct() public {
        _list(1, 1 ether);
        vm.prank(alice);
        r.buy{value: 1.01 ether}(1, 1 ether);
        assertEq(nft.ownerOf(1001), alice);
        assertEq(feeTo.balance, 0.01 ether);
        assertEq(seller.balance, 0.99 ether);
        assertEq(address(r).balance, 0);
        assertEq(alice.balance, 1000 ether - 1.01 ether);
    }

    function test_subscriber_fee_0_8pct_and_expiry() public {
        _list(1, 1 ether);
        address[] memory u = new address[](1);
        uint64[] memory t = new uint64[](1);
        u[0] = alice; t[0] = uint64(block.timestamp + 30 days);
        vm.prank(owner);
        r.setSubscribers(u, t);
        vm.prank(alice);
        r.buy{value: 1.008 ether}(1, 1 ether);
        assertEq(feeTo.balance, 0.008 ether);

        _list(2, 1 ether);
        vm.warp(block.timestamp + 31 days); // expired -> 1%
        vm.prank(alice);
        vm.expectRevert(TsdRouter.Underpaid.selector);
        r.buy{value: 1.008 ether}(2, 1 ether);
        vm.prank(alice);
        r.buy{value: 1.01 ether}(2, 1 ether);
        assertEq(feeTo.balance, 0.018 ether);
    }

    function test_operator_can_set_subscribers_stranger_cannot() public {
        address[] memory u = new address[](1);
        uint64[] memory t = new uint64[](1);
        u[0] = alice; t[0] = type(uint64).max;
        vm.prank(alice);
        vm.expectRevert(TsdRouter.NotAuth.selector);
        r.setSubscribers(u, t);
        vm.prank(owner);
        r.setOperator(op);
        vm.prank(op);
        r.setSubscribers(u, t);
        assertEq(r.feeBpsOf(alice), 80);
        // operator cannot touch anything else
        vm.prank(op);
        vm.expectRevert(TsdRouter.NotOwner.selector);
        r.setPaused(true);
    }

    function test_refund_excess() public {
        _list(1, 1 ether);
        uint256 before_ = alice.balance;
        vm.prank(alice);
        r.buy{value: 5 ether}(1, 1 ether);
        assertEq(before_ - alice.balance, 1.01 ether);
        assertEq(address(r).balance, 0);
    }

    function test_market_dust_refund_is_returned_not_stored() public {
        m.setFlags(true, true);
        _list(1, 1 ether);
        uint256 before_ = alice.balance;
        vm.prank(alice);
        r.buy{value: 1.01 ether}(1, 1 ether);
        assertEq(address(r).balance, 0);
        assertEq(before_ - alice.balance, 1.01 ether - 1);
    }

    // ------------------------------------------------------------ reverts
    function test_underpaid_reverts() public {
        _list(1, 1 ether);
        vm.prank(alice);
        vm.expectRevert(TsdRouter.Underpaid.selector);
        r.buy{value: 1.0099 ether}(1, 1 ether);
    }

    function test_price_mismatch_and_no_listing() public {
        _list(1, 1 ether);
        vm.startPrank(alice);
        vm.expectRevert(TsdRouter.PriceMismatch.selector);
        r.buy{value: 2 ether}(1, 0.5 ether);
        vm.expectRevert(TsdRouter.NoListing.selector);
        r.buy{value: 2 ether}(99, 1 ether);
        vm.stopPrank();
    }

    function test_no_per_tx_cap() public {
        _list(1, 50 ether);
        vm.prank(alice);
        r.buy{value: 50.5 ether}(1, 50 ether);
        assertEq(feeTo.balance, 0.5 ether);
        assertEq(address(r).balance, 0);
    }

    function test_paused() public {
        _list(1, 1 ether);
        vm.prank(owner);
        r.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(TsdRouter.Paused.selector);
        r.buy{value: 1.01 ether}(1, 1 ether);
        vm.prank(owner);
        r.setPaused(false);
        vm.prank(alice);
        r.buy{value: 1.01 ether}(1, 1 ether);
    }

    function test_fee_cap_hardcoded() public {
        assertEq(r.MAX_FEE_BPS(), 200);
        vm.startPrank(owner);
        vm.expectRevert(TsdRouter.FeeTooHigh.selector);
        r.setFees(201, 80);
        vm.expectRevert(TsdRouter.FeeTooHigh.selector);
        r.setFees(100, 101); // subscriber fee may not exceed base
        r.setFees(200, 150);
        assertEq(r.baseFeeBps(), 200);
        vm.stopPrank();
    }

    function test_only_owner_admin_and_two_step_ownership() public {
        vm.startPrank(alice);
        vm.expectRevert(TsdRouter.NotOwner.selector);
        r.setPaused(true);
        vm.expectRevert(TsdRouter.NotOwner.selector);
        r.setFeeRecipient(alice);
        vm.expectRevert(TsdRouter.NotOwner.selector);
        r.setFees(1, 1);
        vm.expectRevert(TsdRouter.NotOwner.selector);
        r.sweepStray(alice);
        vm.stopPrank();

        vm.prank(owner);
        r.transferOwnership(alice);
        vm.prank(address(0xBAD));
        vm.expectRevert(TsdRouter.NotAuth.selector);
        r.acceptOwnership();
        vm.prank(alice);
        r.acceptOwnership();
        assertEq(r.owner(), alice);
    }

    function test_feeRecipient_settable_and_not_zero() public {
        vm.startPrank(owner);
        vm.expectRevert(TsdRouter.ZeroAddress.selector);
        r.setFeeRecipient(address(0));
        r.setFeeRecipient(address(0xBEEF));
        vm.stopPrank();
        _list(1, 1 ether);
        vm.prank(alice);
        r.buy{value: 1.01 ether}(1, 1 ether);
        assertEq(address(0xBEEF).balance, 0.01 ether);
    }

    function test_cannot_receive_unsolicited_bnb_or_nft() public {
        vm.prank(alice);
        (bool ok,) = address(r).call{value: 1 ether}("");
        assertFalse(ok);
        vm.expectRevert(TsdRouter.Unexpected.selector);
        r.onERC721Received(address(0), address(0), 1, "");
    }

    function test_stray_bnb_does_not_break_buys_and_is_sweepable() public {
        vm.deal(address(r), 3 ether); // simulates selfdestruct-forced BNB
        _list(1, 1 ether);
        vm.prank(alice);
        r.buy{value: 1.01 ether}(1, 1 ether);
        assertEq(address(r).balance, 3 ether); // untouched
        vm.prank(owner);
        r.sweepStray(owner);
        assertEq(address(r).balance, 0);
        assertEq(owner.balance, 3 ether);
    }

    function test_fee_recipient_rejecting_bnb_reverts_whole_tx() public {
        Rejector rej = new Rejector();
        vm.prank(owner);
        r.setFeeRecipient(address(rej));
        _list(1, 1 ether);
        vm.prank(alice);
        vm.expectRevert(TsdRouter.SendFailed.selector);
        r.buy{value: 1.01 ether}(1, 1 ether);
        assertEq(nft.ownerOf(1001), address(m)); // nothing moved
    }

    // ------------------------------------------------------------ reentrancy
    function test_reentrancy_via_fee_recipient_blocked() public {
        ReenterFeeRecipient bad = new ReenterFeeRecipient();
        bad.set(r);
        vm.prank(owner);
        r.setFeeRecipient(address(bad));
        _list(1, 1 ether);
        vm.prank(alice);
        // inner buy reverts (Reentrancy) inside try/catch; outer fee send succeeds
        r.buy{value: 1.01 ether}(1, 1 ether);
        assertTrue(bad.tried());
        assertTrue(bad.reverted());
        assertEq(address(r).balance, 0);
    }

    function test_reentrancy_via_refund_blocked() public {
        ReenterBuyer b = new ReenterBuyer();
        _list(1, 1 ether);
        _list(2, 1 ether);
        vm.deal(address(b), 10 ether);
        b.go{value: 3 ether}(r, 1, 1 ether); // 1.99 ether refund triggers receive()
        assertTrue(b.tried());
        assertTrue(b.reverted());
        assertEq(address(r).balance, 0);
        assertEq(nft.ownerOf(1001), address(b));
        assertEq(nft.ownerOf(1002), address(m)); // second listing untouched
    }

    // ------------------------------------------------------------ no approvals / fuzz
    function test_router_has_no_approve_surface() public {
        // the ABI exposes no approve/setApprovalForAll/transfer-token function; check selectors do not exist
        bytes4[4] memory sels = [bytes4(0x095ea7b3), 0xa22cb465, 0xa9059cbb, 0x23b872dd];
        for (uint256 i; i < sels.length; ++i) {
            (bool ok,) = address(r).call(abi.encodePacked(sels[i], new bytes(96)));
            assertFalse(ok);
        }
    }

    function testFuzz_fee_math(uint96 price, bool sub) public {
        price = uint96(bound(price, 1, 1 ether));
        if (sub) {
            address[] memory u = new address[](1);
            uint64[] memory t = new uint64[](1);
            u[0] = alice; t[0] = type(uint64).max;
            vm.prank(owner);
            r.setSubscribers(u, t);
        }
        (uint256 fee, uint256 total, uint16 bps) = r.quote(alice, price);
        assertEq(bps, sub ? 80 : 100);
        assertEq(fee, (uint256(price) * bps) / 10_000);
        assertEq(total, price + fee);
        assertLe(fee, (uint256(price) * 200) / 10_000); // never above the 2% cap
    }

    function testFuzz_buy_zero_leftover_and_exact_accounting(uint96 price, uint96 extra, bool sub) public {
        price = uint96(bound(price, 1, 1 ether));
        extra = uint96(bound(extra, 0, 50 ether));
        if (sub) {
            address[] memory u = new address[](1);
            uint64[] memory t = new uint64[](1);
            u[0] = alice; t[0] = type(uint64).max;
            vm.prank(owner);
            r.setSubscribers(u, t);
        }
        _list(7, price);
        (uint256 fee, uint256 total,) = r.quote(alice, price);
        uint256 a0 = alice.balance;
        uint256 f0 = feeTo.balance;
        uint256 s0 = seller.balance;
        vm.prank(alice);
        r.buy{value: total + extra}(7, price);
        assertEq(address(r).balance, 0, "router leftover");
        assertEq(a0 - alice.balance, total, "buyer paid exactly price+fee");
        assertEq(feeTo.balance - f0, fee, "fee");
        assertEq(seller.balance - s0, price - price / 100, "seller 99%");
        assertEq(nft.ownerOf(1007), alice);
    }

    function testFuzz_underpay_always_reverts(uint96 price, uint96 short) public {
        price = uint96(bound(price, 100, 1 ether));
        _list(7, price);
        (, uint256 total,) = r.quote(alice, price);
        short = uint96(bound(short, 1, total));
        vm.prank(alice);
        vm.expectRevert(TsdRouter.Underpaid.selector);
        r.buy{value: total - short}(7, price);
    }

    function testFuzz_setFees_never_exceeds_cap(uint16 b, uint16 s) public {
        vm.prank(owner);
        try r.setFees(b, s) {
            assertLe(r.baseFeeBps(), 200);
            assertLe(r.subFeeBps(), r.baseFeeBps());
        } catch {
            assertTrue(b > 200 || s > b);
        }
    }
}
