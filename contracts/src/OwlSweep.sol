// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title OwlSweep - one-tx floor sweep on top of TsdRouter.
/// @notice Buys up to MAX_ITEMS listings through the existing TsdRouter (same 1% fee, same fee
///         recipient), forwards every NFT to the caller and refunds all unspent BNB in the same tx.
///         A listing that is gone or repriced is skipped, not fatal; `minFilled` lets the caller
///         revert if too few were bought. Holds no balance, no approvals, no admin, no upgrade.
///         Independent tool. NOT an official TapeOut product.
interface IRouter {
    function market() external view returns (address);
    function quote(address user, uint256 price) external view returns (uint256 fee, uint256 total, uint16 bps);
    function buy(uint256 listingId, uint96 price) external payable;
}

interface IMarketView {
    function listings(uint256 id)
        external
        view
        returns (address seller, address nft, uint96 price, uint256 bps, uint256 tokenId);
}

interface INft {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

contract OwlSweep {
    uint256 public constant MAX_ITEMS = 20;
    IRouter public immutable router;
    IMarketView public immutable market;

    uint256 private _lock = 1;

    event Swept(address indexed buyer, uint256 requested, uint256 filled, uint256 spent);
    event Skipped(uint256 indexed listingId);

    error Reentrancy();
    error ZeroAddress();
    error BadLength();
    error TooFewFilled(uint256 filled);
    error NftNotReceived();
    error SendFailed();
    error Unexpected();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address router_) {
        if (router_ == address(0)) revert ZeroAddress();
        router = IRouter(router_);
        market = IMarketView(IRouter(router_).market());
    }

    /// @notice Total BNB to send for `prices` (price + router fee each, fee charged at this contract's rate).
    function quoteMany(uint96[] calldata prices) external view returns (uint256 total) {
        for (uint256 i; i < prices.length; ++i) {
            (, uint256 t,) = router.quote(address(this), prices[i]);
            total += t;
        }
    }

    /// @notice Buy `ids` at exactly `prices`, cheapest first is the caller's choice of order.
    ///         Send >= quoteMany(prices); everything not spent comes back in the same tx.
    function buyMany(uint256[] calldata ids, uint96[] calldata prices, uint256 minFilled)
        external
        payable
        nonReentrant
    {
        uint256 n = ids.length;
        if (n == 0 || n != prices.length || n > MAX_ITEMS) revert BadLength();

        uint256 pre = address(this).balance - msg.value; // must be unchanged after the tx
        uint256 filled;
        for (uint256 i; i < n; ++i) {
            (, address nft, uint96 lp,, uint256 tokenId) = market.listings(ids[i]);
            (, uint256 total,) = router.quote(address(this), prices[i]);
            if (nft == address(0) || lp != prices[i] || address(this).balance - pre < total) {
                emit Skipped(ids[i]);
                continue;
            }
            try router.buy{value: total}(ids[i], prices[i]) {
                if (INft(nft).ownerOf(tokenId) != address(this)) revert NftNotReceived();
                INft(nft).transferFrom(address(this), msg.sender, tokenId);
                ++filled;
            } catch {
                emit Skipped(ids[i]);
            }
        }
        if (filled < minFilled) revert TooFewFilled(filled);

        uint256 refund = address(this).balance - pre;
        if (refund > 0) _send(msg.sender, refund);
        if (address(this).balance != pre) revert Unexpected(); // zero leftover, always

        emit Swept(msg.sender, n, filled, msg.value - refund);
    }

    function _send(address to, uint256 amt) private {
        (bool ok,) = to.call{value: amt}("");
        if (!ok) revert SendFailed();
    }

    /// @dev Router refunds land here only while a sweep is in flight.
    receive() external payable {
        if (_lock != 2) revert Unexpected();
    }
}
