// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";

interface IWOKB {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IVoucher {
    function totalSupply() external view returns (uint256);
    function tokenByIndex(uint256) external view returns (uint256);
    function ownerOf(uint256) external view returns (address);
    function approve(address, uint256) external;
    function transferFrom(address, address, uint256) external;
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
struct AdvancedOrder { OrderParameters parameters; uint120 numerator; uint120 denominator; bytes signature; bytes extraData; }
struct CriteriaResolver { uint256 orderIndex; uint8 side; uint256 index; uint256 identifier; bytes32[] criteriaProof; }
struct FulfillmentComponent { uint256 orderIndex; uint256 itemIndex; }
struct Fulfillment { FulfillmentComponent[] offerComponents; FulfillmentComponent[] considerationComponents; }
struct AdditionalRecipient { uint256 amount; address payable recipient; }
struct BasicOrderParameters {
    address considerationToken; uint256 considerationIdentifier; uint256 considerationAmount; address payable offerer; address zone;
    address offerToken; uint256 offerIdentifier; uint256 offerAmount; uint8 basicOrderType; uint256 startTime; uint256 endTime;
    bytes32 zoneHash; uint256 salt; bytes32 offererConduitKey; bytes32 fulfillerConduitKey; uint256 totalOriginalAdditionalRecipients;
    AdditionalRecipient[] additionalRecipients; bytes signature;
}
struct Execution { ReceivedItem item; address offerer; bytes32 conduitKey; }
struct ReceivedItem { uint8 itemType; address token; uint256 identifier; uint256 amount; address payable recipient; }

interface ISeaport {
    function information() external view returns (string memory version, bytes32 domainSeparator, address conduitController);
    function getCounter(address) external view returns (uint256);
    function getOrderHash(OrderComponents calldata) external view returns (bytes32);
    function getOrderStatus(bytes32) external view returns (bool, bool, uint256, uint256);
    function cancel(OrderComponents[] calldata) external returns (bool);
    function fulfillBasicOrder(BasicOrderParameters calldata) external payable returns (bool);
    function matchAdvancedOrders(AdvancedOrder[] calldata, CriteriaResolver[] calldata, Fulfillment[] calldata, address) external payable returns (Execution[] memory);
    function incrementCounter() external returns (uint256);
}

/// spec-xlayer-market B: Seaport 1.6 on X Layer (196) with a real Rig Bridge voucher. No real funds, no mainnet txs.
/// Flows the site uses: (1) list voucher for native OKB + buy (basic, ETH_TO_ERC721), (2) WOKB offer on one voucher + accept (basic, ERC721_TO_ERC20),
/// (3) WOKB collection offer (criteria 0 = any voucher) + accept via matchAdvancedOrders (seller needs only the NFT approval), (4) cancel / counter.
/// forge test --match-contract XLSeaportFork -vv
contract XLSeaportFork is Test {
    address constant SEAPORT = 0x0000000000000068F116a894984e2DB1123eB395;
    address constant WOKB = 0xe538905cf8410324e03A5A23C1c177a474D59b2b;
    address constant VOUCH = 0x9cfc959cd42B2e1d39a0d850c528210E818AE520;
    uint256 constant FORK_BLOCK = 74_306_000;
    uint256 constant PRICE = 2 ether;
    uint256 constant FEE = PRICE * 75 / 10000;

    uint256 tid; address seller; uint256 sellerPk; address buyer; uint256 buyerPk;
    address feeTo = address(uint160(uint256(keccak256("tsd.seaport.feeTo"))));
    ISeaport sp = ISeaport(SEAPORT);

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("xlayer"), FORK_BLOCK);
        (seller, sellerPk) = makeAddrAndKey("og.seller");
        (buyer, buyerPk) = makeAddrAndKey("og.buyer");
        vm.deal(buyer, 10 ether); vm.deal(seller, 1 ether);
        vm.prank(buyer); IWOKB(WOKB).deposit{value: 5 ether}();
        tid = IVoucher(VOUCH).tokenByIndex(0);
        address h = IVoucher(VOUCH).ownerOf(tid);
        vm.prank(h); IVoucher(VOUCH).transferFrom(h, seller, tid); // plain transfer works (no hook blocks an EOA receiver)
        assertEq(IVoucher(VOUCH).ownerOf(tid), seller);
    }

    function _params(OrderComponents memory oc) internal pure returns (OrderParameters memory) {
        return OrderParameters(oc.offerer, oc.zone, oc.offer, oc.consideration, oc.orderType, oc.startTime, oc.endTime, oc.zoneHash, oc.salt, oc.conduitKey, oc.consideration.length);
    }
    function _sig(uint256 pk, OrderComponents memory oc) internal view returns (bytes memory) {
        (, bytes32 ds,) = sp.information();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", ds, sp.getOrderHash(oc))));
        return abi.encodePacked(r, s, v);
    }
    function _base(address off, uint256 salt) internal view returns (OrderComponents memory oc) {
        oc.offerer = off; oc.orderType = 0; oc.startTime = block.timestamp - 60; oc.endTime = block.timestamp + 1 days; oc.salt = salt; oc.counter = sp.getCounter(off);
    }
    // listing: offer = voucher; consideration = OKB (price - fee) -> seller, OKB fee -> feeTo (no fee item when free)
    function _listing(uint256 salt, bool free) internal view returns (OrderComponents memory oc) {
        oc = _base(seller, salt);
        oc.offer = new OfferItem[](1); oc.offer[0] = OfferItem(2, VOUCH, tid, 1, 1);
        oc.consideration = new ConsiderationItem[](free ? 1 : 2);
        oc.consideration[0] = ConsiderationItem(0, address(0), 0, free ? PRICE : PRICE - FEE, free ? PRICE : PRICE - FEE, payable(seller));
        if (!free) oc.consideration[1] = ConsiderationItem(0, address(0), 0, FEE, FEE, payable(feeTo));
    }
    function _buyBasic(OrderComponents memory oc, bytes memory sig) internal view returns (BasicOrderParameters memory b) {
        b.considerationAmount = oc.consideration[0].startAmount; b.offerer = payable(seller); b.offerToken = VOUCH; b.offerIdentifier = tid; b.offerAmount = 1;
        b.basicOrderType = 0; b.startTime = oc.startTime; b.endTime = oc.endTime; b.salt = oc.salt; b.signature = sig;
        b.totalOriginalAdditionalRecipients = oc.consideration.length - 1;
        b.additionalRecipients = new AdditionalRecipient[](oc.consideration.length - 1);
        if (b.additionalRecipients.length > 0) b.additionalRecipients[0] = AdditionalRecipient(FEE, payable(feeTo));
    }
    // offer: offer = WOKB price; consideration = voucher (tid, or criteria 0 = any) -> buyer, WOKB fee -> feeTo
    function _offer(uint256 salt, bool coll) internal view returns (OrderComponents memory oc) {
        oc = _base(buyer, salt);
        oc.offer = new OfferItem[](1); oc.offer[0] = OfferItem(1, WOKB, 0, PRICE, PRICE);
        oc.consideration = new ConsiderationItem[](2);
        oc.consideration[0] = ConsiderationItem(coll ? 4 : 2, VOUCH, coll ? 0 : tid, 1, 1, payable(buyer));
        oc.consideration[1] = ConsiderationItem(1, WOKB, 0, FEE, FEE, payable(feeTo));
    }

    function test_0_seaport_1_6_on_196() public view {
        (string memory ver, bytes32 ds,) = sp.information();
        assertEq(keccak256(bytes(ver)), keccak256("1.6"));
        assertEq(ds, keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Seaport"), keccak256("1.6"), uint256(196), SEAPORT)));
        assertGt(WOKB.code.length, 0);
        console2.log("vouchers", IVoucher(VOUCH).totalSupply(), "tid", tid);
    }

    function test_1_list_okb_and_buy() public {
        vm.prank(seller); IVoucher(VOUCH).approve(SEAPORT, tid); // per-token approval only
        OrderComponents memory oc = _listing(1, false);
        BasicOrderParameters memory b = _buyBasic(oc, _sig(sellerPk, oc));
        uint256 s0 = seller.balance; uint256 f0 = feeTo.balance; uint256 b0 = buyer.balance;
        vm.prank(buyer); uint256 g = gasleft();
        assertTrue(sp.fulfillBasicOrder{value: PRICE}(b));
        console2.log("GAS buy listing:", g - gasleft());
        assertEq(IVoucher(VOUCH).ownerOf(tid), buyer);
        assertEq(b0 - buyer.balance, PRICE, "buyer paid listed price");
        assertEq(seller.balance - s0, PRICE - FEE, "seller nets price - 0.75%");
        assertEq(feeTo.balance - f0, FEE, "fee in OKB");
        (,, uint256 filled,) = sp.getOrderStatus(sp.getOrderHash(oc)); assertEq(filled, 1);
        vm.prank(buyer); vm.expectRevert(); sp.fulfillBasicOrder{value: PRICE}(b); // no replay
    }

    function test_1b_free_listing_and_underpay() public {
        vm.prank(seller); IVoucher(VOUCH).approve(SEAPORT, tid);
        OrderComponents memory oc = _listing(2, true);
        BasicOrderParameters memory b = _buyBasic(oc, _sig(sellerPk, oc));
        vm.prank(buyer); vm.expectRevert(); sp.fulfillBasicOrder{value: PRICE - 1}(b); // underpay fails
        uint256 s0 = seller.balance;
        vm.prank(buyer); assertTrue(sp.fulfillBasicOrder{value: PRICE}(b));
        assertEq(seller.balance - s0, PRICE, "free listing: seller gets 100%");
    }

    function test_2_offer_one_voucher_basic_accept() public {
        vm.prank(buyer); IWOKB(WOKB).approve(SEAPORT, PRICE);
        vm.prank(seller); IVoucher(VOUCH).approve(SEAPORT, tid);
        OrderComponents memory oc = _offer(3, false);
        BasicOrderParameters memory b;
        b.considerationToken = VOUCH; b.considerationIdentifier = tid; b.considerationAmount = 1; b.offerer = payable(buyer);
        b.offerToken = WOKB; b.offerAmount = PRICE; b.basicOrderType = 16; b.startTime = oc.startTime; b.endTime = oc.endTime; b.salt = oc.salt;
        b.totalOriginalAdditionalRecipients = 1; b.additionalRecipients = new AdditionalRecipient[](1); b.additionalRecipients[0] = AdditionalRecipient(FEE, payable(feeTo));
        b.signature = _sig(buyerPk, oc);
        vm.prank(seller); assertTrue(sp.fulfillBasicOrder(b));
        assertEq(IVoucher(VOUCH).ownerOf(tid), buyer);
        assertEq(IWOKB(WOKB).balanceOf(seller), PRICE - FEE, "seller nets price - fee, no WOKB approval needed");
        assertEq(IWOKB(WOKB).balanceOf(feeTo), FEE);
    }

    function _collAccept(OrderComponents memory oc, bytes memory sig, uint256 id) internal returns (Execution[] memory) {
        AdvancedOrder[] memory os = new AdvancedOrder[](2);
        os[0] = AdvancedOrder(_params(oc), 1, 1, sig, "");
        OrderComponents memory mine = _base(seller, 77); // seller's own order: offerer == caller, no signature
        mine.offer = new OfferItem[](1); mine.offer[0] = OfferItem(2, VOUCH, id, 1, 1);
        mine.consideration = new ConsiderationItem[](0);
        os[1] = AdvancedOrder(_params(mine), 1, 1, "", "");
        CriteriaResolver[] memory cr = new CriteriaResolver[](1);
        cr[0] = CriteriaResolver(0, 1, 0, id, new bytes32[](0));
        Fulfillment[] memory fs = new Fulfillment[](2);
        fs[0].offerComponents = new FulfillmentComponent[](1); fs[0].offerComponents[0] = FulfillmentComponent(1, 0); // voucher -> bidder
        fs[0].considerationComponents = new FulfillmentComponent[](1); fs[0].considerationComponents[0] = FulfillmentComponent(0, 0);
        fs[1].offerComponents = new FulfillmentComponent[](1); fs[1].offerComponents[0] = FulfillmentComponent(0, 0); // fee out of the WOKB offer
        fs[1].considerationComponents = new FulfillmentComponent[](1); fs[1].considerationComponents[0] = FulfillmentComponent(0, 1);
        vm.prank(seller); uint256 g = gasleft();
        Execution[] memory ex = sp.matchAdvancedOrders(os, cr, fs, seller); // unspent WOKB (price - fee) goes to the recipient = seller
        console2.log("GAS collection accept:", g - gasleft());
        return ex;
    }

    function test_3_collection_offer_match_accept() public {
        vm.prank(buyer); IWOKB(WOKB).approve(SEAPORT, PRICE);
        vm.prank(seller); IVoucher(VOUCH).approve(SEAPORT, tid);
        OrderComponents memory oc = _offer(4, true);
        bytes memory sig = _sig(buyerPk, oc);
        _collAccept(oc, sig, tid);
        assertEq(IVoucher(VOUCH).ownerOf(tid), buyer);
        assertEq(IWOKB(WOKB).balanceOf(seller), PRICE - FEE, "seller nets price - fee");
        assertEq(IWOKB(WOKB).balanceOf(feeTo), FEE);
        (,, uint256 filled,) = sp.getOrderStatus(sp.getOrderHash(oc)); assertEq(filled, 1, "FULL_OPEN: one voucher per collection offer");
    }

    function test_3b_collection_offer_needs_holder() public {
        vm.prank(buyer); IWOKB(WOKB).approve(SEAPORT, PRICE);
        OrderComponents memory oc = _offer(5, true);
        bytes memory sig = _sig(buyerPk, oc);
        uint256 other = IVoucher(VOUCH).tokenByIndex(1); // seller does not own it
        vm.expectRevert(); this.collAcceptExt(oc, sig, other);
    }
    function collAcceptExt(OrderComponents memory oc, bytes memory sig, uint256 id) external { _collAccept(oc, sig, id); }

    function test_4_cancel_and_counter() public {
        vm.prank(seller); IVoucher(VOUCH).approve(SEAPORT, tid);
        OrderComponents memory oc = _listing(6, false);
        BasicOrderParameters memory b = _buyBasic(oc, _sig(sellerPk, oc));
        OrderComponents[] memory a = new OrderComponents[](1); a[0] = oc;
        vm.prank(seller); sp.cancel(a);
        vm.prank(buyer); vm.expectRevert(); sp.fulfillBasicOrder{value: PRICE}(b);
        OrderComponents memory o2 = _listing(7, false);
        BasicOrderParameters memory b2 = _buyBasic(o2, _sig(sellerPk, o2));
        vm.prank(seller); sp.incrementCounter();
        vm.prank(buyer); vm.expectRevert(); sp.fulfillBasicOrder{value: PRICE}(b2);
    }
}
