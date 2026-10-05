// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title FundingIndexOracle
/// @notice Append-only record of a perpetual market's cumulative funding rate, sampled at every
///         UTC day boundary.
/// @dev `index(market, day)` is the sum of the venue's hourly funding rates from the market's
///      first recorded day up to `day * 1 days`, scaled by 1e18. A positive delta between two days
///      means longs paid shorts over that period. Values can never be revised, and every value can
///      be recomputed by anyone from the venue's public funding history. That is what makes a
///      single publisher acceptable for an experiment.
contract FundingIndexOracle {
    /// @notice The only account allowed to post values.
    address public immutable publisher;

    struct Series {
        uint64 firstDay; // UTC day number (timestamp / 1 days) of the first value
        uint64 lastDay; // UTC day number of the latest value
        bool started;
        mapping(uint64 day => int256 index) indexAt;
    }

    mapping(bytes32 market => Series) private series;

    event IndexPosted(bytes32 indexed market, uint64 indexed day, int256 index);

    error NotPublisher();
    error NotNextDay(uint64 expected, uint64 got);
    error DayNotOver(uint64 day);
    error NoValue(bytes32 market, uint64 day);

    constructor(address publisher_) {
        publisher = publisher_;
    }

    /// @notice Post the cumulative index for `market` at the start of `day`.
    /// @dev Days must be contiguous, so a series has no gaps, and a day can only be posted once
    ///      its boundary has passed.
    function post(bytes32 market, uint64 day, int256 index) external {
        if (msg.sender != publisher) revert NotPublisher();
        if (uint256(day) * 1 days > block.timestamp) revert DayNotOver(day);
        Series storage s = series[market];
        if (!s.started) {
            s.started = true;
            s.firstDay = day;
        } else if (day != s.lastDay + 1) {
            revert NotNextDay(s.lastDay + 1, day);
        }
        s.lastDay = day;
        s.indexAt[day] = index;
        emit IndexPosted(market, day, index);
    }

    /// @notice Whether a value exists for `market` at `day`.
    function has(bytes32 market, uint64 day) public view returns (bool) {
        Series storage s = series[market];
        return s.started && day >= s.firstDay && day <= s.lastDay;
    }

    /// @notice The cumulative index for `market` at `day`. Reverts if it has not been posted.
    function indexAt(bytes32 market, uint64 day) external view returns (int256) {
        if (!has(market, day)) revert NoValue(market, day);
        return series[market].indexAt[day];
    }

    /// @notice First and latest posted day of a market, and whether it has any value.
    function range(bytes32 market) external view returns (uint64 firstDay, uint64 lastDay, bool started) {
        Series storage s = series[market];
        return (s.firstDay, s.lastDay, s.started);
    }
}
