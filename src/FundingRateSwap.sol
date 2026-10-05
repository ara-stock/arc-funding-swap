// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FundingIndexOracle} from "./FundingIndexOracle.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title FundingRateSwap
/// @notice Peer-to-peer fixed-for-floating swaps on a perpetual market's funding rate, settled in
///         USDC.
/// @dev Two counterparties lock equal margin. Over the swap's whole UTC days, the "fixed payer"
///      receives the realised (floating) funding and pays the agreed fixed rate. At maturity the
///      net amount moves from the loser's margin to the winner, capped at that margin. If the
///      oracle never posts the maturity value, both sides can reclaim their margin in full after a
///      grace period. Margin per side is capped: this is an experiment, not a venue.
contract FundingRateSwap {
    IERC20 public immutable usdc; // 6-decimal ERC-20 interface of USDC
    FundingIndexOracle public immutable oracle;

    uint256 public constant MAX_MARGIN = 100e6; // 100 USDC per side
    uint256 public constant MAX_TENOR_DAYS = 30;
    uint256 public constant ORACLE_GRACE = 7 days;
    uint256 private constant SCALE = 1e18;

    enum State {
        None,
        Open,
        Active,
        Closed
    }

    struct Swap {
        // terms
        address maker;
        bool makerPaysFixed; // true: maker receives floating and pays fixed
        bytes32 market;
        uint128 notional; // USDC, 6 decimals
        uint128 margin; // per side, USDC, 6 decimals
        int256 fixedRatePerDay; // funding rate per day, 1e18-scaled (e.g. 0.0003e18 = 0.03%/day)
        uint64 tenorDays;
        uint64 offerExpiry; // unix time after which the offer can no longer be taken
        // filled on take
        address taker;
        uint64 startDay;
        State state;
    }

    Swap[] private swaps;
    bool private locked;

    event OfferCreated(uint256 indexed id, address indexed maker, bytes32 indexed market);
    event OfferCancelled(uint256 indexed id);
    event OfferTaken(uint256 indexed id, address indexed taker, uint64 startDay, uint64 endDay);
    event Settled(uint256 indexed id, int256 floatingSum, int256 fixedSum, uint256 toMaker, uint256 toTaker);
    event Refunded(uint256 indexed id);

    error BadTerms();
    error NotOpen();
    error NotActive();
    error NotMaker();
    error Expired();
    error NotMatured();
    error OracleMissing();
    error StillInGrace();
    error SelfTake();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    constructor(IERC20 usdc_, FundingIndexOracle oracle_) {
        usdc = usdc_;
        oracle = oracle_;
    }

    // ---------------------------------------------------------------- offers

    /// @notice Create an offer and lock the maker's margin. Requires an approval of `margin`.
    function createOffer(
        bytes32 market,
        bool makerPaysFixed,
        uint128 notional,
        uint128 margin,
        int256 fixedRatePerDay,
        uint64 tenorDays,
        uint64 offerExpiry
    ) external nonReentrant returns (uint256 id) {
        if (
            notional == 0 || margin == 0 || margin > MAX_MARGIN || tenorDays == 0 || tenorDays > MAX_TENOR_DAYS
                || offerExpiry <= block.timestamp || fixedRatePerDay > int256(SCALE) || fixedRatePerDay < -int256(SCALE)
        ) revert BadTerms();
        id = swaps.length;
        swaps.push(
            Swap({
                maker: msg.sender,
                makerPaysFixed: makerPaysFixed,
                market: market,
                notional: notional,
                margin: margin,
                fixedRatePerDay: fixedRatePerDay,
                tenorDays: tenorDays,
                offerExpiry: offerExpiry,
                taker: address(0),
                startDay: 0,
                state: State.Open
            })
        );
        _pull(msg.sender, margin);
        emit OfferCreated(id, msg.sender, market);
    }

    /// @notice Withdraw an offer nobody has taken and get the margin back.
    function cancelOffer(uint256 id) external nonReentrant {
        Swap storage s = swaps[id];
        if (s.state != State.Open) revert NotOpen();
        if (msg.sender != s.maker) revert NotMaker();
        s.state = State.Closed;
        _push(s.maker, s.margin);
        emit OfferCancelled(id);
    }

    /// @notice Take an open offer by locking the same margin. The swap starts at the next UTC day.
    function takeOffer(uint256 id) external nonReentrant {
        Swap storage s = swaps[id];
        if (s.state != State.Open) revert NotOpen();
        if (block.timestamp > s.offerExpiry) revert Expired();
        if (msg.sender == s.maker) revert SelfTake();
        uint64 startDay = uint64(block.timestamp / 1 days) + 1;
        s.taker = msg.sender;
        s.startDay = startDay;
        s.state = State.Active;
        _pull(msg.sender, s.margin);
        emit OfferTaken(id, msg.sender, startDay, startDay + s.tenorDays);
    }

    // ---------------------------------------------------------------- settlement

    /// @notice Settle a matured swap. Anyone can call it once the oracle has the maturity value.
    function settle(uint256 id) external nonReentrant {
        Swap storage s = swaps[id];
        if (s.state != State.Active) revert NotActive();
        uint64 endDay = s.startDay + s.tenorDays;
        if (block.timestamp < uint256(endDay) * 1 days) revert NotMatured();
        if (!oracle.has(s.market, s.startDay) || !oracle.has(s.market, endDay)) revert OracleMissing();

        (int256 floatingSum, int256 fixedSum, uint256 toMaker, uint256 toTaker) = _payouts(s, endDay);
        s.state = State.Closed;
        if (toMaker > 0) _push(s.maker, toMaker);
        if (toTaker > 0) _push(s.taker, toTaker);
        emit Settled(id, floatingSum, fixedSum, toMaker, toTaker);
    }

    /// @notice If the oracle has not posted the values needed to settle within the grace period
    ///         after maturity, return both margins in full.
    function refundIfOracleFailed(uint256 id) external nonReentrant {
        Swap storage s = swaps[id];
        if (s.state != State.Active) revert NotActive();
        uint64 endDay = s.startDay + s.tenorDays;
        if (block.timestamp < uint256(endDay) * 1 days + ORACLE_GRACE) revert StillInGrace();
        if (oracle.has(s.market, s.startDay) && oracle.has(s.market, endDay)) revert BadTerms(); // settle instead
        s.state = State.Closed;
        _push(s.maker, s.margin);
        _push(s.taker, s.margin);
        emit Refunded(id);
    }

    // ---------------------------------------------------------------- views

    function swapCount() external view returns (uint256) {
        return swaps.length;
    }

    function getSwap(uint256 id) external view returns (Swap memory) {
        return swaps[id];
    }

    /// @notice What `settle` would pay right now (both values are zero until the swap can settle).
    function previewSettle(uint256 id)
        external
        view
        returns (int256 floatingSum, int256 fixedSum, uint256 toMaker, uint256 toTaker)
    {
        Swap storage s = swaps[id];
        if (s.state != State.Active) return (0, 0, 0, 0);
        uint64 endDay = s.startDay + s.tenorDays;
        if (!oracle.has(s.market, s.startDay) || !oracle.has(s.market, endDay)) return (0, 0, 0, 0);
        return _payouts(s, endDay);
    }

    // ---------------------------------------------------------------- internals

    function _payouts(Swap storage s, uint64 endDay)
        private
        view
        returns (int256 floatingSum, int256 fixedSum, uint256 toMaker, uint256 toTaker)
    {
        floatingSum = oracle.indexAt(s.market, endDay) - oracle.indexAt(s.market, s.startDay);
        fixedSum = s.fixedRatePerDay * int256(uint256(s.tenorDays));
        // Payoff to the fixed payer, in USDC (6 decimals): notional × (floating − fixed).
        int256 toFixedPayer = (int256(uint256(s.notional)) * (floatingSum - fixedSum)) / int256(SCALE);
        int256 margin = int256(uint256(s.margin));
        if (toFixedPayer > margin) toFixedPayer = margin;
        if (toFixedPayer < -margin) toFixedPayer = -margin;
        int256 makerDelta = s.makerPaysFixed ? toFixedPayer : -toFixedPayer;
        toMaker = uint256(margin + makerDelta);
        toTaker = uint256(margin - makerDelta);
    }

    function _pull(address from, uint256 amount) private {
        if (!usdc.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }
}
