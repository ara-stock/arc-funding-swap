// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FundingIndexOracle} from "../src/FundingIndexOracle.sol";
import {FundingRateSwap, IERC20} from "../src/FundingRateSwap.sol";

contract MockUSDC {
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract FundingRateSwapTest is Test {
    bytes32 constant BTC = "HL:BTC";
    uint64 constant DAY0 = 20_000; // an arbitrary UTC day number

    MockUSDC usdc;
    FundingIndexOracle oracle;
    FundingRateSwap swap;
    address publisher = makeAddr("publisher");
    address maker = makeAddr("maker");
    address taker = makeAddr("taker");

    function setUp() public {
        vm.warp(uint256(DAY0) * 1 days + 3 hours);
        usdc = new MockUSDC();
        oracle = new FundingIndexOracle(publisher);
        swap = new FundingRateSwap(IERC20(address(usdc)), oracle);
        for (uint256 i; i < 2; i++) {
            address who = i == 0 ? maker : taker;
            usdc.mint(who, 1_000e6);
            vm.prank(who);
            usdc.approve(address(swap), type(uint256).max);
        }
    }

    // ------------------------------------------------------------ helpers

    /// Post `perDay` of funding for every day from DAY0 up to and including `lastDay`.
    function _postFlat(int256 perDay, uint64 lastDay) internal {
        (, uint64 last, bool started) = oracle.range(BTC);
        uint64 from = started ? last + 1 : DAY0;
        int256 idx = started ? oracle.indexAt(BTC, last) : int256(0);
        for (uint64 d = from; d <= lastDay; d++) {
            if (d != DAY0) idx += perDay;
            vm.warp(uint256(d) * 1 days + 1);
            vm.prank(publisher);
            oracle.post(BTC, d, idx);
        }
    }

    function _offer(bool makerPaysFixed, int256 fixedPerDay, uint64 tenor) internal returns (uint256 id) {
        vm.prank(maker);
        id = swap.createOffer(BTC, makerPaysFixed, 10_000e6, 50e6, fixedPerDay, tenor, uint64(block.timestamp + 1 days));
    }

    // ------------------------------------------------------------ oracle

    function test_oracle_onlyPublisher() public {
        vm.expectRevert(FundingIndexOracle.NotPublisher.selector);
        oracle.post(BTC, DAY0, 0);
    }

    function test_oracle_isAppendOnlyAndContiguous() public {
        vm.startPrank(publisher);
        oracle.post(BTC, DAY0, 1);
        vm.expectRevert(abi.encodeWithSelector(FundingIndexOracle.NotNextDay.selector, DAY0 + 1, DAY0));
        oracle.post(BTC, DAY0, 2); // cannot rewrite
        vm.warp(uint256(DAY0 + 3) * 1 days);
        vm.expectRevert(abi.encodeWithSelector(FundingIndexOracle.NotNextDay.selector, DAY0 + 1, DAY0 + 2));
        oracle.post(BTC, DAY0 + 2, 2); // cannot skip
        vm.stopPrank();
        assertEq(oracle.indexAt(BTC, DAY0), 1);
    }

    function test_oracle_cannotPostFutureDay() public {
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(FundingIndexOracle.DayNotOver.selector, DAY0 + 1));
        oracle.post(BTC, DAY0 + 1, 0);
    }

    // ------------------------------------------------------------ lifecycle

    function test_fixedPayerWinsWhenFundingAboveFixed() public {
        uint256 id = _offer(true, 0.0001e18, 7); // maker pays 0.01%/day fixed
        vm.prank(taker);
        swap.takeOffer(id);
        FundingRateSwap.Swap memory s = swap.getSwap(id);
        assertEq(s.startDay, DAY0 + 1);

        _postFlat(0.0003e18, DAY0 + 8); // realised 0.03%/day
        swap.settle(id);

        // payoff to fixed payer = 10_000 × (7 × 0.0003 − 7 × 0.0001) = 14 USDC
        assertEq(usdc.balanceOf(maker), 1_000e6 + 14e6);
        assertEq(usdc.balanceOf(taker), 1_000e6 - 14e6);
        assertEq(usdc.balanceOf(address(swap)), 0);
    }

    function test_fixedReceiverWinsWhenFundingBelowFixed() public {
        uint256 id = _offer(false, 0.0002e18, 5); // maker receives fixed
        vm.prank(taker);
        swap.takeOffer(id);
        _postFlat(-0.0001e18, DAY0 + 6); // shorts paid longs
        swap.settle(id);
        // payoff to fixed payer (taker) = 10_000 × (5 × −0.0001 − 5 × 0.0002) = −15 USDC
        assertEq(usdc.balanceOf(maker), 1_000e6 + 15e6);
        assertEq(usdc.balanceOf(taker), 1_000e6 - 15e6);
    }

    function test_lossIsCappedAtMargin() public {
        uint256 id = _offer(true, 0, 10);
        vm.prank(taker);
        swap.takeOffer(id);
        _postFlat(0.01e18, DAY0 + 11); // extreme funding: 1%/day
        swap.settle(id);
        assertEq(usdc.balanceOf(maker), 1_000e6 + 50e6);
        assertEq(usdc.balanceOf(taker), 1_000e6 - 50e6);
    }

    function test_cannotSettleBeforeMaturityOrWithoutOracle() public {
        uint256 id = _offer(true, 0, 3);
        vm.prank(taker);
        swap.takeOffer(id);
        vm.expectRevert(FundingRateSwap.NotMatured.selector);
        swap.settle(id);
        vm.warp(uint256(DAY0 + 4) * 1 days);
        vm.expectRevert(FundingRateSwap.OracleMissing.selector);
        swap.settle(id);
    }

    function test_refundWhenOracleFails() public {
        uint256 id = _offer(true, 0, 3);
        vm.prank(taker);
        swap.takeOffer(id);
        vm.warp(uint256(DAY0 + 4) * 1 days + 6 days);
        vm.expectRevert(FundingRateSwap.StillInGrace.selector);
        swap.refundIfOracleFailed(id);
        vm.warp(uint256(DAY0 + 4) * 1 days + 7 days);
        swap.refundIfOracleFailed(id);
        assertEq(usdc.balanceOf(maker), 1_000e6);
        assertEq(usdc.balanceOf(taker), 1_000e6);
    }

    function test_noRefundWhenOracleDelivered() public {
        uint256 id = _offer(true, 0, 3);
        vm.prank(taker);
        swap.takeOffer(id);
        _postFlat(0.0001e18, DAY0 + 4);
        vm.warp(uint256(DAY0 + 4) * 1 days + 8 days);
        vm.expectRevert(FundingRateSwap.BadTerms.selector);
        swap.refundIfOracleFailed(id);
    }

    function test_cancelOpenOffer() public {
        uint256 id = _offer(true, 0, 3);
        vm.prank(taker);
        vm.expectRevert(FundingRateSwap.NotMaker.selector);
        swap.cancelOffer(id);
        vm.prank(maker);
        swap.cancelOffer(id);
        assertEq(usdc.balanceOf(maker), 1_000e6);
        vm.prank(taker);
        vm.expectRevert(FundingRateSwap.NotOpen.selector);
        swap.takeOffer(id);
    }

    function test_offerRules() public {
        uint256 id = _offer(true, 0, 3);
        vm.prank(maker);
        vm.expectRevert(FundingRateSwap.SelfTake.selector);
        swap.takeOffer(id);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(taker);
        vm.expectRevert(FundingRateSwap.Expired.selector);
        swap.takeOffer(id);

        vm.startPrank(maker);
        vm.expectRevert(FundingRateSwap.BadTerms.selector);
        swap.createOffer(BTC, true, 1e6, 101e6, 0, 3, uint64(block.timestamp + 1)); // margin over cap
        vm.expectRevert(FundingRateSwap.BadTerms.selector);
        swap.createOffer(BTC, true, 1e6, 1e6, 0, 31, uint64(block.timestamp + 1)); // tenor over cap
        vm.stopPrank();
    }

    function test_cannotSettleTwice() public {
        uint256 id = _offer(true, 0, 2);
        vm.prank(taker);
        swap.takeOffer(id);
        _postFlat(0.0001e18, DAY0 + 3);
        swap.settle(id);
        vm.expectRevert(FundingRateSwap.NotActive.selector);
        swap.settle(id);
    }

    /// Settlement never creates or destroys money: payouts always sum to both margins.
    function testFuzz_payoutsConserveMargin(
        bool makerPaysFixed,
        int64 fixedPerDay,
        int64 floatPerDay,
        uint64 tenor,
        uint96 notional,
        uint32 margin
    ) public {
        tenor = uint64(bound(tenor, 1, 30));
        margin = uint32(bound(margin, 1, 100e6));
        notional = uint96(bound(notional, 1, 1e15));
        fixedPerDay = int64(bound(fixedPerDay, -0.01e18, 0.01e18)); // within ±1%/day
        floatPerDay = int64(bound(floatPerDay, -0.01e18, 0.01e18));
        vm.prank(maker);
        uint256 id = swap.createOffer(
            BTC, makerPaysFixed, notional, margin, int256(fixedPerDay), tenor, uint64(block.timestamp + 1 days)
        );
        vm.prank(taker);
        swap.takeOffer(id);
        _postFlat(int256(floatPerDay), DAY0 + 1 + tenor);
        swap.settle(id);
        assertEq(usdc.balanceOf(maker) + usdc.balanceOf(taker), 2_000e6);
        assertEq(usdc.balanceOf(address(swap)), 0);
    }
}
