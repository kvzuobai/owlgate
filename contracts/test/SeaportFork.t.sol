// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";

interface IWBNB {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}

interface INFT2 {
    function ownerOf(uint256) external view returns (address);
    function approve(address, uint256) external;
}

struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }
struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address payable recipient; }
struct OrderComponents {
    address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType;
    uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 counter;
}
struct OrderParameters {
    address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType;
    uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems;
}
struct Order { OrderParameters parameters; bytes signature; }
struct AdditionalRecipient { uint256 amount; address payable recipient; }
struct BasicOrderParameters {
    address considerationToken; uint256 considerationIdentifier; uint256 considerationAmount; address payable offerer; address zone;
    address offerToken; uint256 offerIdentifier; uint256 offerAmount; uint8 basicOrderType; uint256 startTime; uint256 endTime;
    bytes32 zoneHash; uint256 salt; bytes32 offererConduitKey; bytes32 fulfillerConduitKey; uint256 totalOriginalAdditionalRecipients;
    AdditionalRecipient[] additionalRecipients; bytes signature;
}

interface ISeaport {
    function information() external view returns (string memory version, bytes32 domainSeparator, address conduitController);
    function name() external view returns (string memory);
    function getCounter(address) external view returns (uint256);
    function getOrderHash(OrderComponents calldata) external view returns (bytes32);
    function getOrderStatus(bytes32) external view returns (bool, bool, uint256, uint256);
    function fulfillOrder(Order calldata, bytes32 fulfillerConduitKey) external payable returns (bool);
    function cancel(OrderComponents[] calldata) external returns (bool);
    function fulfillBasicOrder(BasicOrderParameters calldata) external payable returns (bool);
    function incrementCounter() external returns (uint256);
}

/// D42 P0 Seaport gate: token-specific WBNB offer for a real circuit NFT on a BSC fork. No real funds, no mainnet txs.
/// forge test --match-contract SeaportFork -vv
contract SeaportFork is Test {
    address constant SEAPORT = 0x0000000000000068F116a894984e2DB1123eB395;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant CMKT = 0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f;
    uint256 constant FORK_BLOCK = 127_700_610;
    uint256 constant PRICE = 0.5 ether;

    address nft; uint256 tid; address holder;
    address buyer; uint256 buyerPk;
    address feeTo = address(uint160(uint256(keccak256("tsd.seaport.feeTo"))));
    ISeaport sp = ISeaport(SEAPORT);

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("bsc"), FORK_BLOCK);
        (buyer, buyerPk) = makeAddrAndKey("tsd.buyer");
        vm.deal(buyer, 10 ether);
        vm.startPrank(buyer);
        IWBNB(WBNB).deposit{value: 5 ether}();
        vm.stopPrank();
        // same finder as ListFork: a non-listed circuit NFT owned by an EOA
        (, bytes memory d) = CMKT.staticcall(abi.encodeWithSelector(0xaaccf1ec));
        uint256 n = abi.decode(d, (uint256));
        for (uint256 i = n; i > n - 60; --i) {
            (, bytes memory r) = CMKT.staticcall(abi.encodeWithSelector(0xde74e57b, i - 1));
            (, address nf,,, uint256 t) = abi.decode(r, (address, address, uint96, uint256, uint256));
            if (nf == address(0)) continue;
            nft = nf;
            for (uint256 k = 1; k < 4000 && holder == address(0); ++k) {
                uint256 c = t > k ? t - k : t + k;
                (bool ok, bytes memory od) = nf.staticcall(abi.encodeWithSelector(0x6352211e, c));
                if (!ok) continue;
                address h = abi.decode(od, (address));
                if (h.code.length != 0 || h == address(0)) continue;
                (, bytes memory lo) = CMKT.staticcall(abi.encodeWithSelector(0x216f2f24, nf, c));
                if (lo.length >= 32 && abi.decode(lo, (uint256)) != 0) continue;
                holder = h; tid = c;
            }
            if (holder != address(0)) return;
        }
        revert("no holder found");
    }

    function _order(uint256 price, uint256 feeAmt, uint256 salt) internal view returns (OrderComponents memory oc) {
        oc.offerer = buyer;
        oc.offer = new OfferItem[](1);
        oc.offer[0] = OfferItem(1, WBNB, 0, price, price);
        oc.consideration = new ConsiderationItem[](feeAmt > 0 ? 2 : 1);
        oc.consideration[0] = ConsiderationItem(2, nft, tid, 1, 1, payable(buyer)); // circuit NFT -> bidder
        if (feeAmt > 0) oc.consideration[1] = ConsiderationItem(1, WBNB, 0, feeAmt, feeAmt, payable(feeTo)); // optional TSD fee: Seaport pulls it from the FULFILLER (seller), not from the offer
        oc.orderType = 0; // FULL_OPEN
        oc.startTime = block.timestamp;
        oc.endTime = block.timestamp + 1 days;
        oc.salt = salt;
        oc.counter = sp.getCounter(buyer);
    }

    function _sign(OrderComponents memory oc) internal view returns (Order memory o) {
        (, bytes32 ds,) = sp.information();
        bytes32 h = sp.getOrderHash(oc);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", ds, h)));
        o.parameters = OrderParameters(oc.offerer, oc.zone, oc.offer, oc.consideration, oc.orderType, oc.startTime, oc.endTime, oc.zoneHash, oc.salt, oc.conduitKey, oc.consideration.length);
        o.signature = abi.encodePacked(r, s, v);
    }

    function test_0_is_seaport_1_6() public view {
        (string memory ver, bytes32 ds, address cc) = sp.information();
        console2.log("name()", sp.name());
        console2.log("information().version", ver);
        console2.log("domainSeparator");
        console2.logBytes32(ds);
        console2.log("conduitController", cc);
        console2.log("code size", SEAPORT.code.length);
        console2.log("codehash");
        console2.logBytes32(SEAPORT.codehash);
        assertEq(keccak256(bytes(ver)), keccak256("1.6"));
        assertEq(keccak256(bytes(sp.name())), keccak256("Seaport"));
        // domain separator must be EIP-712 with name Seaport / version 1.6 / chain 56 / this address
        bytes32 expect = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Seaport"), keccak256("1.6"), uint256(56), SEAPORT));
        assertEq(ds, expect);
    }

    function test_1_token_specific_wbnb_offer_fill() public {
        vm.prank(buyer);
        IWBNB(WBNB).approve(SEAPORT, PRICE); // exact amount only
        vm.prank(holder);
        INFT2(nft).approve(SEAPORT, tid);    // per-token approve only, no setApprovalForAll
        OrderComponents memory oc = _order(PRICE, 0, 1);
        Order memory o = _sign(oc);
        uint256 bW = IWBNB(WBNB).balanceOf(buyer);
        uint256 sW = IWBNB(WBNB).balanceOf(holder);
        uint256 fW = IWBNB(WBNB).balanceOf(feeTo);
        vm.prank(holder);
        uint256 g0 = gasleft();
        bool ok = sp.fulfillOrder(o, bytes32(0));
        console2.log("GAS fulfillOrder (no fee item):", g0 - gasleft());
        assertTrue(ok);
        assertEq(INFT2(nft).ownerOf(tid), buyer, "NFT moved to buyer");
        assertEq(bW - IWBNB(WBNB).balanceOf(buyer), PRICE, "buyer paid exactly price");
        assertEq(IWBNB(WBNB).balanceOf(holder) - sW, PRICE, "seller received 100%");
        assertEq(IWBNB(WBNB).balanceOf(feeTo), fW, "fee recipient 0");
        assertEq(IWBNB(WBNB).allowance(buyer, SEAPORT), 0, "exact allowance consumed");
        bytes32 h = sp.getOrderHash(oc);
        (, , uint256 filled,) = sp.getOrderStatus(h);
        assertEq(filled, 1);
        // replay must fail
        vm.prank(holder);
        vm.expectRevert();
        sp.fulfillOrder(o, bytes32(0));
    }

    /// TSD fee as an extra consideration item: measure who actually pays it.
    function test_1b_fee_item_behaviour() public {
        uint256 fee = PRICE * 50 / 10000;
        vm.prank(buyer);
        IWBNB(WBNB).approve(SEAPORT, PRICE);
        vm.prank(holder);
        INFT2(nft).approve(SEAPORT, tid);
        Order memory o = _sign(_order(PRICE, fee, 2));
        uint256 bW = IWBNB(WBNB).balanceOf(buyer);
        uint256 sW = IWBNB(WBNB).balanceOf(holder);
        vm.prank(holder);
        // fee item is an ERC20 the FULFILLER must supply (Seaport pulls consideration from the fulfiller) -> seller needs WBNB + approval
        (bool ok,) = address(sp).call(abi.encodeCall(ISeaport.fulfillOrder, (o, bytes32(0))));
        console2.log("fee item as extra consideration, seller has no WBNB ok=", ok);
        // give the seller the fee amount and approve
        deal(WBNB, holder, IWBNB(WBNB).balanceOf(holder) + fee);
        vm.prank(holder);
        IWBNB(WBNB).approve(SEAPORT, fee);
        vm.prank(holder);
        uint256 g0 = gasleft();
        (ok,) = address(sp).call(abi.encodeCall(ISeaport.fulfillOrder, (o, bytes32(0))));
        console2.log("GAS fulfillOrder (with fee item):", g0 - gasleft());
        console2.log("fee item, seller funded+approved ok=", ok);
        console2.log("buyer paid", bW - IWBNB(WBNB).balanceOf(buyer));
        console2.log("seller net delta", int256(IWBNB(WBNB).balanceOf(holder)) - int256(sW + fee));
        console2.log("feeTo got", IWBNB(WBNB).balanceOf(feeTo));
    }

    function test_2_cancel_and_increment_counter() public {
        vm.prank(buyer);
        IWBNB(WBNB).approve(SEAPORT, PRICE);
        vm.prank(holder);
        INFT2(nft).approve(SEAPORT, tid);
        OrderComponents memory oc = _order(PRICE, 0, 3);
        Order memory o = _sign(oc);
        // stranger cannot cancel
        OrderComponents[] memory arr = new OrderComponents[](1);
        arr[0] = oc;
        vm.prank(holder);
        vm.expectRevert();
        sp.cancel(arr);
        // offerer cancels (costs gas)
        vm.prank(buyer);
        uint256 g0 = gasleft();
        sp.cancel(arr);
        console2.log("GAS cancel(1 order):", g0 - gasleft());
        vm.prank(holder);
        vm.expectRevert();
        sp.fulfillOrder(o, bytes32(0));
        // second order: incrementCounter kills all previously signed orders
        OrderComponents memory oc2 = _order(PRICE, 0, 4);
        Order memory o2 = _sign(oc2);
        vm.prank(buyer);
        g0 = gasleft();
        sp.incrementCounter();
        console2.log("GAS incrementCounter:", g0 - gasleft());
        vm.prank(holder);
        vm.expectRevert();
        sp.fulfillOrder(o2, bytes32(0));
        assertEq(INFT2(nft).ownerOf(tid), holder, "nft never moved");
    }

    function test_3_invalidation_edges() public {
        vm.prank(holder);
        INFT2(nft).approve(SEAPORT, tid);
        Order memory o = _sign(_order(PRICE, 0, 5));
        // no WBNB allowance
        vm.prank(holder);
        vm.expectRevert();
        sp.fulfillOrder(o, bytes32(0));
        // allowance below price
        vm.prank(buyer);
        IWBNB(WBNB).approve(SEAPORT, PRICE - 1);
        vm.prank(holder);
        vm.expectRevert();
        sp.fulfillOrder(o, bytes32(0));
        // allowance OK but seller never approved the NFT to Seaport
        vm.prank(buyer);
        IWBNB(WBNB).approve(SEAPORT, PRICE);
        vm.prank(holder);
        INFT2(nft).approve(address(0xdead), tid);
        vm.prank(holder);
        vm.expectRevert();
        sp.fulfillOrder(o, bytes32(0));
        // stranger (not owner) cannot fill even with approvals
        vm.prank(holder);
        INFT2(nft).approve(SEAPORT, tid);
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        sp.fulfillOrder(o, bytes32(0));
        // expiry
        vm.warp(block.timestamp + 2 days);
        vm.prank(holder);
        vm.expectRevert();
        sp.fulfillOrder(o, bytes32(0));
        // wrong signer (tampered price)
        vm.warp(block.timestamp - 2 days);
        o.parameters.offer[0].startAmount = PRICE - 1;
        o.parameters.offer[0].endAmount = PRICE - 1;
        vm.prank(holder);
        vm.expectRevert();
        sp.fulfillOrder(o, bytes32(0));
    }

    /// Buyer drains WBNB after signing: order must fail, never partially fill.
    function test_4_buyer_spends_wbnb_after_sign() public {
        vm.prank(buyer);
        IWBNB(WBNB).approve(SEAPORT, PRICE);
        vm.prank(holder);
        INFT2(nft).approve(SEAPORT, tid);
        Order memory o = _sign(_order(PRICE, 0, 6));
        uint256 all = IWBNB(WBNB).balanceOf(buyer);
        vm.prank(buyer);
        (bool t,) = WBNB.call(abi.encodeWithSignature("transfer(address,uint256)", address(0xdead), all));
        assertTrue(t);
        vm.prank(holder);
        vm.expectRevert();
        sp.fulfillOrder(o, bytes32(0));
        assertEq(INFT2(nft).ownerOf(tid), holder);
    }

    /// Token listed on CMKT while a Seaport bid is filled: whichever fills first wins, the other must fail.
    function test_5_listed_on_cmkt_conflict() public {
        vm.prank(holder);
        (bool a,) = nft.call(abi.encodeWithSignature("setApprovalForAll(address,bool)", CMKT, true));
        assertTrue(a);
        vm.prank(holder);
        (bool l,) = CMKT.call(abi.encodeWithSelector(0x5e60f358, nft, tid, uint96(1 ether)));
        assertTrue(l, "list");
        (, bytes memory lr) = CMKT.staticcall(abi.encodeWithSelector(0x216f2f24, nft, tid));
        uint256 lid = abi.decode(lr, (uint256));
        console2.log("ownerOf while listed == CMKT (escrow):", INFT2(nft).ownerOf(tid) == CMKT);
        console2.log("ownerOf while listed == seller:", INFT2(nft).ownerOf(tid) == holder);
        vm.prank(buyer);
        IWBNB(WBNB).approve(SEAPORT, PRICE);
        vm.prank(holder);
        INFT2(nft).approve(SEAPORT, tid);
        Order memory o = _sign(_order(PRICE, 0, 7));
        vm.prank(holder);
        bool ok = sp.fulfillOrder(o, bytes32(0));
        console2.log("Seaport bid filled while CMKT listing active:", ok);
        assertEq(INFT2(nft).ownerOf(tid), buyer);
        address eve = address(0xE1E);
        vm.deal(eve, 5 ether);
        vm.prank(eve);
        (bool b,) = CMKT.call{value: 1 ether}(abi.encodeWithSelector(0x24b6434b, lid, uint96(1 ether)));
        console2.log("stale CMKT listing still buyable after Seaport fill (want false):", b);
    }

    /// Plain transfer hook probe: transferFrom to EOA and to a contract w/o ERC721Receiver.
    function test_6_transfer_hooks_probe() public {
        vm.prank(holder);
        INFT2(nft).approve(SEAPORT, tid);
        vm.prank(buyer);
        IWBNB(WBNB).approve(SEAPORT, PRICE);
        uint256 g0 = gasleft();
        vm.prank(holder);
        (bool ok,) = nft.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", holder, buyer, tid));
        console2.log("GAS raw transferFrom (owner->EOA):", g0 - gasleft());
        console2.log("transferFrom ok", ok);
        // after the token moves, an order for it by buyer->itself is moot; check approval reset
        (, bytes memory r) = nft.staticcall(abi.encodeWithSelector(0x081812fc, tid));
        console2.log("approval cleared after transfer:", abi.decode(r, (address)) == address(0));
        // paused / locked? try the transfer back from buyer
        vm.prank(buyer);
        (ok,) = nft.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", buyer, holder, tid));
        console2.log("second transfer ok", ok);
    }

    /// P2 (D44): seller accepts with fulfillBasicOrder route ERC721_TO_ERC20 (type 16). Fee 0.75% is paid out of the bidder's offer:
    /// seller needs ONLY the per-token NFT approval (no WBNB approval), nets price - fee.
    function test_7_basic_accept_fee_from_offer() public {
        uint256 fee = PRICE * 75 / 10000;
        vm.prank(buyer);
        IWBNB(WBNB).approve(SEAPORT, PRICE);
        vm.prank(holder);
        INFT2(nft).approve(SEAPORT, tid);
        OrderComponents memory oc = _order(PRICE, fee, 8);
        Order memory o = _sign(oc);
        BasicOrderParameters memory b;
        b.considerationToken = nft; b.considerationIdentifier = tid; b.considerationAmount = 1; b.offerer = payable(buyer);
        b.offerToken = WBNB; b.offerAmount = PRICE; b.basicOrderType = 16; b.startTime = oc.startTime; b.endTime = oc.endTime;
        b.salt = oc.salt; b.totalOriginalAdditionalRecipients = 1;
        b.additionalRecipients = new AdditionalRecipient[](1);
        b.additionalRecipients[0] = AdditionalRecipient(fee, payable(feeTo));
        b.signature = o.signature;
        uint256 bW = IWBNB(WBNB).balanceOf(buyer);
        uint256 sW = IWBNB(WBNB).balanceOf(holder);
        vm.prank(holder);
        uint256 g0 = gasleft();
        assertTrue(sp.fulfillBasicOrder(b));
        console2.log("GAS fulfillBasicOrder (accept, fee):", g0 - gasleft());
        assertEq(INFT2(nft).ownerOf(tid), buyer);
        assertEq(bW - IWBNB(WBNB).balanceOf(buyer), PRICE, "bidder pays exactly price");
        assertEq(IWBNB(WBNB).balanceOf(holder) - sW, PRICE - fee, "seller nets price - fee");
        assertEq(IWBNB(WBNB).balanceOf(feeTo), fee, "fee 0.75%");
        (, , uint256 filled,) = sp.getOrderStatus(sp.getOrderHash(oc));
        assertEq(filled, 1);
    }

    /// Fee-free offer (each wallet's first 5, founder 2026-10-27): NFT-only consideration, basic accept with 0 additional recipients.
    function test_8_basic_accept_free_offer() public {
        vm.prank(buyer);
        IWBNB(WBNB).approve(SEAPORT, PRICE);
        vm.prank(holder);
        INFT2(nft).approve(SEAPORT, tid);
        OrderComponents memory oc = _order(PRICE, 0, 9);
        Order memory o = _sign(oc);
        BasicOrderParameters memory b;
        b.considerationToken = nft; b.considerationIdentifier = tid; b.considerationAmount = 1; b.offerer = payable(buyer);
        b.offerToken = WBNB; b.offerAmount = PRICE; b.basicOrderType = 16; b.startTime = oc.startTime; b.endTime = oc.endTime;
        b.salt = oc.salt; b.totalOriginalAdditionalRecipients = 0;
        b.signature = o.signature;
        uint256 bW = IWBNB(WBNB).balanceOf(buyer);
        uint256 sW = IWBNB(WBNB).balanceOf(holder);
        uint256 fW = IWBNB(WBNB).balanceOf(feeTo);
        vm.prank(holder);
        assertTrue(sp.fulfillBasicOrder(b));
        assertEq(INFT2(nft).ownerOf(tid), buyer);
        assertEq(bW - IWBNB(WBNB).balanceOf(buyer), PRICE, "bidder pays exactly price");
        assertEq(IWBNB(WBNB).balanceOf(holder) - sW, PRICE, "seller gets the full price");
        assertEq(IWBNB(WBNB).balanceOf(feeTo), fW, "no fee");
    }
}
