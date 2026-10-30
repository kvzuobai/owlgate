// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {TsdRouter} from "../src/TsdRouter.sol";

interface INFT {
    function ownerOf(uint256) external view returns (address);
    function approve(address, uint256) external;
    function getApproved(uint256) external view returns (address);
    function setApprovalForAll(address, bool) external;
    function isApprovedForAll(address, address) external view returns (bool);
}

/// D37: fork-test of real CMKT list/setPrice/delist/buy. Read-only fork, no real funds, no mainnet txs.
/// forge test --match-contract ListFork -vv   (rpc "bsc" from foundry.toml, pinned block below)
contract ListFork is Test {
    address constant CMKT = 0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f;
    uint256 constant FORK_BLOCK = 127_700_610;
    address owner = address(uint160(uint256(keccak256("tsd.owner"))));
    address feeTo = address(uint160(uint256(keccak256("tsd.feeTo"))));
    address bob = address(uint160(uint256(keccak256("tsd.bob"))));
    address eve = address(uint160(uint256(keccak256("tsd.eve"))));

    address nft;
    uint256 tid;
    address holder;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("bsc"), FORK_BLOCK);
        vm.deal(bob, 100 ether);
        vm.deal(eve, 100 ether);
        (, bytes memory d) = CMKT.staticcall(abi.encodeWithSelector(0xaaccf1ec));
        uint256 n = abi.decode(d, (uint256));
        for (uint256 i = n; i > n - 60; --i) {
            (address s, address nf, uint256 t) = _l3(i - 1);
            s;
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
                holder = h;
                tid = c;
            }
            if (holder != address(0)) return;
        }
        revert("no holder found");
    }

    function _l3(uint256 id) internal view returns (address s, address nf, uint256 t) {
        (, bytes memory r) = CMKT.staticcall(abi.encodeWithSelector(0xde74e57b, id));
        (s, nf,,, t) = abi.decode(r, (address, address, uint96, uint256, uint256));
    }

    function _list(address who, address cp, uint256 id, uint96 p) internal returns (bool ok, bytes memory ret) {
        vm.prank(who);
        (ok, ret) = CMKT.call(abi.encodeWithSelector(0x5e60f358, cp, id, p));
    }

    function _listing(uint256 id) internal view returns (address s, address nf, uint96 p, uint256 bps, uint256 t) {
        (, bytes memory r) = CMKT.staticcall(abi.encodeWithSelector(0xde74e57b, id));
        return abi.decode(r, (address, address, uint96, uint256, uint256));
    }

    function _logListing(uint256 id) internal view {
        (address s, address nf, uint96 p, uint256 bps, uint256 t) = _listing(id);
        console2.log("  seller==holder", s == holder);
        console2.log("  nft ok", nf == nft);
        console2.log("  price", p);
        console2.log("  bps", bps);
        console2.log("  tokenId ok", t == tid);
    }

    function _owed(address a) internal view returns (uint256) {
        (, bytes memory d) = CMKT.staticcall(abi.encodeWithSelector(0xdf18e047, a));
        return abi.decode(d, (uint256));
    }

    function _next() internal view returns (uint256) {
        (, bytes memory d) = CMKT.staticcall(abi.encodeWithSelector(0xaaccf1ec));
        return abi.decode(d, (uint256));
    }

    function test_0_sample_active_listing_escrow() public view {
        (, bytes memory d) = CMKT.staticcall(abi.encodeWithSelector(0xaaccf1ec));
        uint256 n = abi.decode(d, (uint256));
        for (uint256 i = n; i > n - 60; --i) {
            (address s, address nf, uint256 t) = _l3(i - 1);
            if (nf == address(0)) continue;
            address o = INFT(nf).ownerOf(t);
            console2.log("active listing", i - 1);
            console2.log("  seller", s);
            console2.log("  ownerOf while listed", o);
            console2.log("  escrowed in CMKT?", o == CMKT);
            return;
        }
    }

    function test_1_approve_single_token_only() public {
        console2.log("holder", holder);
        console2.log("nft", nft);
        console2.log("tokenId", tid);
        vm.prank(holder);
        INFT(nft).approve(CMKT, tid);
        console2.log("getApproved==CMKT", INFT(nft).getApproved(tid) == CMKT);
        (bool ok, bytes memory r) = _list(holder, nft, tid, 0.5 ether);
        console2.log("(1) list with approve(CMKT,id) only ok=", ok);
        if (!ok) console2.logBytes(r);
    }

    function _buyDirect(uint256 id, uint96 p) internal returns (bool ok) {
        vm.prank(bob);
        (ok,) = CMKT.call{value: p}(abi.encodeWithSelector(0x24b6434b, id, p));
    }

    function test_1b_no_approval_list_and_buy() public {
        (bool ok,) = _list(holder, nft, tid, 0.5 ether);
        console2.log("(1b) list with NO approval ok=", ok);
        if (!ok) return;
        uint256 id = _next();
        console2.log("     buy of that listing ok=", _buyDirect(id, 0.5 ether));
    }

    function test_1c_approve_single_then_buy() public {
        vm.prank(holder);
        INFT(nft).approve(CMKT, tid);
        console2.log("(1c) isApprovedForAll after approve()", INFT(nft).isApprovedForAll(holder, CMKT));
        (bool ok,) = _list(holder, nft, tid, 0.5 ether);
        uint256 id = _next();
        console2.log("     list ok=", ok);
        console2.log("     direct CMKT buy ok=", _buyDirect(id, 0.5 ether));
        console2.log("     NFT owner==bob", INFT(nft).ownerOf(tid) == bob);
    }

    function test_1d_setApprovalForAll_then_buy_and_revoke() public {
        vm.prank(holder);
        INFT(nft).setApprovalForAll(CMKT, true);
        (bool ok,) = _list(holder, nft, tid, 0.5 ether);
        uint256 id = _next();
        vm.prank(holder);
        INFT(nft).setApprovalForAll(CMKT, false); // revoke after listing
        console2.log("(1d) after revoke, buy ok=", _buyDirect(id, 0.5 ether));
        console2.log("     list ok=", ok);
    }

    function test_2_setApprovalForAll_then_lifecycle() public {
        vm.prank(holder);
        INFT(nft).setApprovalForAll(CMKT, true);
        (bool ok, bytes memory r) = _list(holder, nft, tid, 0.5 ether);
        uint256 id = _next(); // CMKT increments nextListingId BEFORE assigning: new id == nextListingId after list
        console2.log("(2) list with setApprovalForAll ok=", ok);
        if (!ok) {
            console2.logBytes(r);
            return;
        }
        console2.log("  new listing id", id);
        console2.log("  nextListingId now", _next());
        _logListing(id);
        console2.log("(3) owner after list", INFT(nft).ownerOf(tid));
        console2.log("  escrowed in CMKT?", INFT(nft).ownerOf(tid) == CMKT);
        vm.prank(eve);
        (bool e1,) = CMKT.call(abi.encodeWithSelector(0x3d8886f1, id, uint96(1 ether)));
        console2.log("  setPrice by stranger ok (want false)=", e1);
        vm.prank(holder);
        (bool sp,) = CMKT.call(abi.encodeWithSelector(0x3d8886f1, id, uint96(0.7 ether)));
        (,, uint96 p2,,) = _listing(id);
        console2.log("  setPrice by seller ok=", sp);
        console2.log("  price now", p2);
        vm.prank(eve);
        (bool e2,) = CMKT.call(abi.encodeWithSelector(0x964bc33f, id));
        console2.log("  delist by stranger ok (want false)=", e2);
        vm.prank(holder);
        (bool dl,) = CMKT.call(abi.encodeWithSelector(0x964bc33f, id));
        (address s3,,,,) = _listing(id);
        console2.log("  delist by seller ok=", dl);
        console2.log("  seller after delist", s3);
        console2.log("  owner after delist", INFT(nft).ownerOf(tid));
        console2.log("  buy delisted ok (want false)=", _buyRaw(id));
    }

    function _buyRaw(uint256 id) internal returns (bool bd) {
        vm.prank(bob);
        (bd,) = CMKT.call{value: 0.7 ether}(abi.encodeWithSelector(0x24b6434b, id, uint96(0.7 ether)));
    }

    function test_4_list_then_buy_via_router() public {
        vm.prank(holder);
        INFT(nft).setApprovalForAll(CMKT, true);
        (bool ok,) = _list(holder, nft, tid, 1 ether);
        require(ok, "list failed");
        uint256 id = _next();
        TsdRouter r = new TsdRouter(CMKT, owner, feeTo);
        uint256 sBal = holder.balance;
        uint256 fBal = feeTo.balance;
        (, bytes memory pwd) = CMKT.staticcall(abi.encodeWithSelector(0x06d6e63f));
        address proto = abi.decode(pwd, (address));
        uint256 pw = proto.balance;
        uint256 ow0 = _owed(proto);
        uint256 bBal = bob.balance;
        uint256 fee = uint256(1 ether) * uint256(r.feeBpsOf(bob)) / 10000;
        vm.prank(bob);
        r.buy{value: 1 ether + fee + 0.3 ether}(id, uint96(1 ether));
        console2.log("(4) buyer net paid (0.3 excess sent)", int256(bBal) - int256(bob.balance));
        console2.log("  NFT owner==bob", INFT(nft).ownerOf(tid) == bob);
        console2.log("  seller delta", int256(holder.balance) - int256(sBal));
        console2.log("  protocolWallet", proto);
        console2.log("  protocolWallet delta", int256(proto.balance) - int256(pw));
        console2.log("  owed(protocolWallet) delta (CMKT 1% accrued, pull)", _owed(proto) - ow0);
        console2.log("  TSD feeRecipient delta", int256(feeTo.balance) - int256(fBal));
        console2.log("  router leftover", address(r).balance);
    }

    function test_5_edges() public {
        vm.prank(holder);
        INFT(nft).setApprovalForAll(CMKT, true);
        vm.prank(eve);
        INFT(nft).setApprovalForAll(CMKT, true);
        (bool a,) = _list(eve, nft, tid, 1 ether);
        console2.log("(5a) list token not owned ok (want false)=", a);
        (bool z,) = _list(holder, nft, tid, 0);
        console2.log("(5b) price 0 ok=", z);
        uint256 n0 = _next();
        (bool l1,) = _list(holder, nft, tid, 1 ether);
        uint256 id = _next();
        (bool l2,) = _list(holder, nft, tid, 2 ether);
        console2.log("(5c) first list ok=", l1);
        console2.log("     list again while listed ok=", l2);
        console2.log("     nextListingId delta", _next() - n0);
        {
            (address sA,,,,) = _listing(id);
            (address sB,,,,) = _listing(id + 1);
            console2.log("     first listing seller", sA);
            console2.log("     second listing seller", sB);
        }
        vm.prank(holder);
        (bool o,) = CMKT.call(abi.encodeWithSelector(0x5e60f358, nft, tid, uint256(1) << 96));
        console2.log("(5d) price 2^96 raw overflow arg ok (want false)=", o);
        vm.prank(holder);
        (bool d0,) = CMKT.call(abi.encodeWithSelector(0x964bc33f, id));
        console2.log("     delist ok", d0);
        (bool mx,) = _list(holder, nft, tid, type(uint96).max);
        console2.log("(5e) price uint96.max ok=", mx);
        (bool ne,) = _list(holder, address(0xdead), 1, 1 ether);
        console2.log("(5f) list on non-contract nft ok (want false)=", ne);
        console2.logBytes(abi.encodeWithSelector(0x5e60f358, nft, tid, uint96(0.5 ether)));
    }
}
