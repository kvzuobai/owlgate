// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title TsdRouter - non-custodial pass-through buy router for the TapeOut circuit market (CMKT).
/// @notice One tx: user pays price + fee, router buys on CMKT, forwards the NFT to the user, sends the
///         fee to feeRecipient and refunds any excess. The router NEVER keeps a balance after a tx
///         (asserted on-chain), holds no token approvals and has no admin power over user assets.
///         Independent tool. NOT an official TapeOut product.
interface ICMKT {
    function buy(uint256 listingId, uint96 price) external payable;
    // Observed layout (CMKT impl 0x7257..3dfb): seller, nft, price, bps snapshot (100), tokenId
    function listings(uint256 id)
        external
        view
        returns (address seller, address nft, uint96 price, uint256 bps, uint256 tokenId);
}

interface IERC721Min {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

contract TsdRouter {
    // ---------------------------------------------------------------- constants / immutables
    uint16 public constant MAX_FEE_BPS = 200; // hard cap 2.00%, cannot be changed
    uint16 public constant BPS = 10_000;
    ICMKT public immutable market;

    // ---------------------------------------------------------------- state
    address public owner;
    address public pendingOwner;
    address public operator; // may only update the subscriber list
    address public feeRecipient;
    uint16 public baseFeeBps = 100; // 1.00%
    uint16 public subFeeBps = 80; // 0.80% for active subscribers
    bool public paused;
    mapping(address => uint64) public subscriberUntil; // unix time; 0 = not a subscriber

    uint256 private _lock = 1;
    bool private _receiving;

    // ---------------------------------------------------------------- events
    event Bought(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed nft,
        uint256 tokenId,
        uint256 price,
        uint256 fee,
        uint16 feeBps
    );
    event OwnerTransferStarted(address indexed from, address indexed to);
    event OwnerChanged(address indexed to);
    event OperatorChanged(address indexed to);
    event FeeRecipientChanged(address indexed to);
    event FeesChanged(uint16 baseBps, uint16 subBps);
    event PausedChanged(bool paused);
    event SubscriberSet(address indexed user, uint64 until);

    // ---------------------------------------------------------------- errors
    error Paused();
    error Reentrancy();
    error NotOwner();
    error NotAuth();
    error ZeroAddress();
    error FeeTooHigh();
    error BadLength();
    error NoListing();
    error PriceMismatch();
    error Underpaid();
    error NftNotReceived();
    error SendFailed();
    error Unexpected();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address market_, address owner_, address feeRecipient_) {
        if (market_ == address(0) || owner_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        market = ICMKT(market_);
        owner = owner_;
        feeRecipient = feeRecipient_;
    }

    // ---------------------------------------------------------------- views
    function feeBpsOf(address user) public view returns (uint16) {
        return subscriberUntil[user] >= block.timestamp ? subFeeBps : baseFeeBps;
    }

    /// @return fee BNB fee in wei, total = price + fee (what msg.value must at least be), bps applied
    function quote(address user, uint256 price) public view returns (uint256 fee, uint256 total, uint16 bps) {
        bps = feeBpsOf(user);
        fee = (price * bps) / BPS;
        total = price + fee;
    }

    // ---------------------------------------------------------------- core
    /// @notice Buy listing `listingId` on CMKT at exactly `price`. Send >= price + fee; excess is refunded.
    function buy(uint256 listingId, uint96 price) external payable nonReentrant {
        if (paused) revert Paused();
        (, address nft, uint96 lp,, uint256 tokenId) = market.listings(listingId);
        if (nft == address(0) || lp == 0) revert NoListing();
        if (lp != price) revert PriceMismatch();

        (uint256 fee, uint256 total, uint16 bps) = quote(msg.sender, price);
        if (msg.value < total) revert Underpaid();

        uint256 pre = address(this).balance - msg.value; // balance that must be unchanged after the tx

        _receiving = true;
        market.buy{value: price}(listingId, price);
        _receiving = false;

        if (IERC721Min(nft).ownerOf(tokenId) != address(this)) revert NftNotReceived();
        IERC721Min(nft).transferFrom(address(this), msg.sender, tokenId);

        if (fee > 0) _send(feeRecipient, fee);
        uint256 refund = address(this).balance - pre;
        if (refund > 0) _send(msg.sender, refund);
        if (address(this).balance != pre) revert Unexpected(); // zero leftover, always

        emit Bought(listingId, msg.sender, nft, tokenId, price, fee, bps);
    }

    function _send(address to, uint256 amt) private {
        (bool ok,) = to.call{value: amt}("");
        if (!ok) revert SendFailed();
    }

    /// @dev Only accept NFTs / BNB while a buy is in flight.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (!_receiving) revert Unexpected();
        return this.onERC721Received.selector;
    }

    receive() external payable {
        if (!_receiving) revert Unexpected();
    }

    // ---------------------------------------------------------------- admin (owner = founder)
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedChanged(p);
    }

    function setFeeRecipient(address a) external onlyOwner {
        if (a == address(0)) revert ZeroAddress();
        feeRecipient = a;
        emit FeeRecipientChanged(a);
    }

    function setFees(uint16 baseBps, uint16 subBps) external onlyOwner {
        if (baseBps > MAX_FEE_BPS || subBps > baseBps) revert FeeTooHigh();
        baseFeeBps = baseBps;
        subFeeBps = subBps;
        emit FeesChanged(baseBps, subBps);
    }

    function setOperator(address a) external onlyOwner {
        operator = a;
        emit OperatorChanged(a);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnerTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotAuth();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerChanged(msg.sender);
    }

    /// @notice Subscriber list, synced from the bot paid list (30-day expiry each). Max impact of a bad
    ///         entry = a 0.2% discount for that address. Callable by owner or operator.
    function setSubscribers(address[] calldata users, uint64[] calldata untils) external {
        if (msg.sender != owner && msg.sender != operator) revert NotAuth();
        if (users.length != untils.length || users.length > 200) revert BadLength();
        for (uint256 i; i < users.length; ++i) {
            subscriberUntil[users[i]] = untils[i];
            emit SubscriberSet(users[i], untils[i]);
        }
    }

    /// @notice Recover BNB force-sent to the router (e.g. selfdestruct). User funds never rest here.
    function sweepStray(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        _send(to, address(this).balance);
    }
}
