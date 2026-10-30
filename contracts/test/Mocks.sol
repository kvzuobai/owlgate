// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TsdRouter} from "../src/TsdRouter.sol";

contract MockNFT {
    mapping(uint256 => address) public ownerOf;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from && (msg.sender == from), "nft");
        ownerOf[id] = to;
    }
}

/// Mimics CMKT: buy(id, price) payable, exact price, 99% to seller / 1% kept, NFT to msg.sender.
contract MockCMKT {
    struct L { address seller; address nft; uint96 price; uint256 bps; uint256 tokenId; }
    mapping(uint256 => L) public listings;
    uint256 public kept;
    bool public refundDust; // when true, send 1 wei back to the caller (tests that router refunds it)
    bool public useSafeCallback;

    function setFlags(bool dust, bool cb) external { refundDust = dust; useSafeCallback = cb; }

    function list(uint256 id, address seller, address nft, uint96 price, uint256 tokenId) external {
        listings[id] = L(seller, nft, price, 100, tokenId);
        MockNFT(nft).mint(address(this), tokenId);
    }

    function buy(uint256 id, uint96 price) external payable {
        L memory l = listings[id];
        require(l.nft != address(0) && l.price == price && msg.value >= price, "mkt");
        delete listings[id];
        uint256 f = price / 100;
        kept += f;
        (bool ok,) = l.seller.call{value: price - f}("");
        require(ok, "pay");
        if (useSafeCallback) {
            require(TsdRouter(payable(msg.sender)).onERC721Received(address(this), l.seller, l.tokenId, "") == 0x150b7a02, "cb");
        }
        MockMkt_transfer(l.nft, msg.sender, l.tokenId);
        if (refundDust) {
            (ok,) = msg.sender.call{value: 1}("");
            require(ok, "dust");
        }
        uint256 extra = msg.value - price;
        if (extra > 0) { (ok,) = msg.sender.call{value: extra}(""); require(ok, "extra"); }
    }

    function MockMkt_transfer(address nft, address to, uint256 id) internal {
        // market owns the NFT, sets owner directly via mint helper (mock)
        MockNFT(nft).mint(to, id);
    }
}

/// Fee recipient that tries to re-enter the router during fee payment.
contract ReenterFeeRecipient {
    TsdRouter public r;
    bool public tried;
    bool public reverted;

    function set(TsdRouter r_) external { r = r_; }

    receive() external payable {
        tried = true;
        try r.buy{value: msg.value}(1, 1) {} catch { reverted = true; }
    }
}

/// Buyer contract that tries to re-enter during the refund.
contract ReenterBuyer {
    TsdRouter public r;
    bool public tried;
    bool public reverted;
    uint256 public id; uint96 public price;

    function go(TsdRouter r_, uint256 id_, uint96 price_) external payable {
        r = r_; id = id_; price = price_;
        r.buy{value: msg.value}(id_, price_);
    }

    receive() external payable {
        if (msg.sender != address(r) || tried) return;
        tried = true;
        try r.buy{value: 0}(id, price) {} catch { reverted = true; }
    }
}

contract Rejector {
    receive() external payable { revert("no"); }
}
