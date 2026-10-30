// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TsdRouter, ICMKT, IERC721Min} from "../src/TsdRouter.sol";
import {ReenterBuyer} from "./Mocks.sol";

/// BSC mainnet fork tests against the REAL CMKT (0x6feE..B46f). Read-only fork, no real funds:
/// forge test --match-contract Fork --fork-url https://tapeout.net/rpc --fork-block-number 127700610
contract ForkTest is Test {
    ICMKT constant CMKT = ICMKT(0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f);
    uint256 constant FORK_BLOCK = 127_700_610;

    address owner = address(uint160(uint256(keccak256("tsd.owner"))));
    address feeTo = address(uint160(uint256(keccak256("tsd.feeTo"))));
    address alice = address(uint160(uint256(keccak256("tsd.alice"))));
    TsdRouter r;

    uint256 id;
    address seller;
    address nft;
    uint96 price;
    uint256 tokenId;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("bsc"), FORK_BLOCK);
        r = new TsdRouter(address(CMKT), owner, feeTo);
        vm.deal(alice, 100 ether);
        (bool ok, bytes memory d) = address(CMKT).staticcall(abi.encodeWithSelector(0xaaccf1ec)); // nextListingId()
        require(ok, "nextListingId");
        uint256 n = abi.decode(d, (uint256));
        for (uint256 i = n; i > n - 40; --i) {
            (address s, address nf, uint96 p,, uint256 t) = CMKT.listings(i - 1);
            if (nf != address(0) && p > 0 && p <= 1 ether && s.code.length == 0) {
                id = i - 1; seller = s; nft = nf; price = p; tokenId = t;
                return;
            }
        }
        revert("no active listing in last 40 ids");
    }

    // ---------------------------------------------------------------- P0: direct buy on CMKT
    function test_P0_cmkt_direct_buy_costs_price_x1_00() public {
        uint256 a0 = alice.balance;
        uint256 s0 = seller.balance;
        vm.prank(alice);
        CMKT.buy{value: price}(id, price);
        assertEq(a0 - alice.balance, price, "buyer paid exactly listing price (x1.00)");
        assertEq(IERC721Min(nft).ownerOf(tokenId), alice, "nft delivered to buyer");
        // CMKT fee (1%) is taken from the seller: seller gets 99%
        assertEq(seller.balance - s0, price - price / 100, "seller receives 99%");
        (, address nf,,,) = CMKT.listings(id);
        assertEq(nf, address(0), "listing cleared");
    }

    function test_P0_cmkt_underpay_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        CMKT.buy{value: price - 1}(id, price);
    }

    function test_P0_cmkt_wrong_price_arg_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        CMKT.buy{value: price}(id, price + 1);
    }

    function test_P0_cmkt_overpay_behaviour_is_recorded() public {
        // Documents what CMKT does with msg.value > price: refund, or keep (then router must send exactly price).
        uint256 a0 = alice.balance;
        vm.prank(alice);
        try CMKT.buy{value: price + 1 ether}(id, price) {
            emit log_named_uint("overpay: buyer net cost", a0 - alice.balance);
        } catch {
            emit log("overpay: CMKT reverts when msg.value != price");
        }
    }

    // ---------------------------------------------------------------- P1: router on the real market
    function test_router_buy_real_cmkt_fee_1pct_zero_leftover() public {
        uint256 fee = (uint256(price) * 100) / 10_000;
        uint256 a0 = alice.balance;
        uint256 s0 = seller.balance;
        vm.prank(alice);
        r.buy{value: uint256(price) + fee}(id, price);
        assertEq(IERC721Min(nft).ownerOf(tokenId), alice);
        assertEq(feeTo.balance, fee);
        assertEq(a0 - alice.balance, uint256(price) + fee, "buyer total = price x1.01");
        assertEq(seller.balance - s0, price - price / 100, "seller still gets 99%");
        assertEq(address(r).balance, 0, "router holds nothing");
    }

    function test_router_buy_real_cmkt_refunds_excess() public {
        uint256 fee = (uint256(price) * 100) / 10_000;
        uint256 a0 = alice.balance;
        vm.prank(alice);
        r.buy{value: uint256(price) + fee + 5 ether}(id, price);
        assertEq(a0 - alice.balance, uint256(price) + fee);
        assertEq(address(r).balance, 0);
    }

    function test_router_subscriber_0_8pct_real_cmkt() public {
        address[] memory u = new address[](1);
        uint64[] memory t = new uint64[](1);
        u[0] = alice; t[0] = uint64(block.timestamp + 30 days);
        vm.prank(owner);
        r.setSubscribers(u, t);
        uint256 fee = (uint256(price) * 80) / 10_000;
        vm.prank(alice);
        r.buy{value: uint256(price) + fee}(id, price);
        assertEq(feeTo.balance, fee);
        assertEq(address(r).balance, 0);
        assertEq(IERC721Min(nft).ownerOf(tokenId), alice);
    }

    function test_router_paused_real_cmkt() public {
        vm.prank(owner);
        r.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(TsdRouter.Paused.selector);
        r.buy{value: 2 ether}(id, price);
        vm.startPrank(owner);
        r.setPaused(false);
        vm.stopPrank();
    }

    function test_router_reentrancy_on_refund_real_cmkt() public {
        ReenterBuyer b = new ReenterBuyer();
        vm.deal(address(b), 10 ether);
        b.go{value: uint256(price) * 2 + 1 ether}(r, id, price);
        assertTrue(b.tried());
        assertTrue(b.reverted());
        assertEq(address(r).balance, 0);
        assertEq(IERC721Min(nft).ownerOf(tokenId), address(b));
    }

    /// Fuzz the overpay amount against the real market: buyer always pays exactly price+fee, router ends at 0.
    function testFuzz_router_real_cmkt_overpay(uint96 extra) public {
        extra = uint96(bound(extra, 0, 50 ether));
        (uint256 fee, uint256 total,) = r.quote(alice, price);
        uint256 a0 = alice.balance;
        vm.prank(alice);
        r.buy{value: total + extra}(id, price);
        assertEq(a0 - alice.balance, total);
        assertEq(address(r).balance, 0);
        assertEq(feeTo.balance, fee);
    }

    function test_router_wrong_price_reverts_real_cmkt() public {
        vm.prank(alice);
        vm.expectRevert(TsdRouter.PriceMismatch.selector);
        r.buy{value: 2 ether}(id, price + 1);
    }
}

