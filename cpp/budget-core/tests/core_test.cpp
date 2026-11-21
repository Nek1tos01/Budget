#include "budget_core.hpp"

#include <array>
#include <cstdlib>
#include <iostream>
#include <limits>

using namespace budget;

void expect(bool ok, const char* message) {
    if (!ok) {
        std::cerr << message << '\n';
        std::exit(EXIT_FAILURE);
    }
}

int main() {
    constexpr auto max = std::numeric_limits<Money>::max();
    constexpr auto min = std::numeric_limits<Money>::min();
    Money value{};
    expect(add_money(50'000, 125'050, value) == Status::ok && value == 175'050, "exact addition");
    expect(subtract_money(100, 101, value) == Status::ok && value == -1, "negative balance");
    expect(add_money(max, 1, value) == Status::overflow, "positive addition overflow");
    expect(add_money(min, -1, value) == Status::overflow, "negative addition overflow");
    expect(subtract_money(min, 1, value) == Status::overflow, "negative subtraction overflow");
    expect(subtract_money(max, -1, value) == Status::overflow, "positive subtraction overflow");
    expect(subtract_money(min, min, value) == Status::ok && value == 0, "signed boundary subtraction");
    expect(round_up_to_ruble(0, value) == Status::ok && value == 0, "zero stays zero");
    expect(round_up_to_ruble(50'000, value) == Status::ok && value == 50'000, "whole rubles stay unchanged");
    expect(round_up_to_ruble(50'001, value) == Status::ok && value == 50'100, "one kopeck rounds up");
    expect(round_up_to_ruble(50'050, value) == Status::ok && value == 50'100, "fifty kopecks round up");
    expect(round_up_to_ruble(50'099, value) == Status::ok && value == 50'100, "ninety-nine kopecks round up");
    expect(round_up_to_ruble(-1, value) == Status::invalid_input, "negative amount rejected");
    expect(round_up_to_ruble(max - 7, value) == Status::ok && value == max - 7, "largest whole amount stays unchanged");
    expect(round_up_to_ruble(max - 6, value) == Status::overflow && value == max - 7, "rounding overflow leaves result unchanged");
    expect(usage_percent(max, max, value) == Status::ok && value == 100, "exact percentage at int64 limit");
    expect(usage_percent(max, 1, value) == Status::overflow, "percentage result overflow");
    expect(usage_percent(-1, 1, value) == Status::invalid_input, "negative spending rejected");
    expect(percent_change(199, 200, value) == Status::ok && value == 0, "negative half rounds toward positive infinity");
    expect(percent_change(197, 200, value) == Status::ok && value == -1, "negative one and a half rounds toward positive infinity");
    expect(percent_change(201, 200, value) == Status::ok && value == 1, "positive half rounds up");

    BudgetPeriod week{}, month{}, shifted{};
    expect(period(20260101, PeriodKind::week, 4, 0, week) == Status::ok && week.start == 20260101 && week.end == 20260108, "week starts Thursday");
    expect(period(20260101, PeriodKind::week, 5, 0, shifted) == Status::ok && shifted.start == 20251226 && shifted.end == 20260102, "new week start across years");
    expect(period(20260101, PeriodKind::month, 4, -1, shifted) == Status::ok && shifted.start == 20251201 && shifted.end == 20260101, "previous month across years");
    expect(period(20240229, PeriodKind::month, 4, 0, shifted) == Status::ok && shifted.start == 20240201 && shifted.end == 20240301, "leap month end");
    expect(period(20230229, PeriodKind::month, 4, 0, shifted) == Status::invalid_input, "invalid leap date");
    expect(period(20260101, PeriodKind::week, 0, 0, shifted) == Status::invalid_input, "invalid week start");
    expect(period(20260101, PeriodKind::week, 4, std::numeric_limits<int>::max(), shifted) == Status::invalid_input, "invalid far offset");
    expect(period(20260101, PeriodKind::month, 4, 0, month) == Status::ok, "month period calculated");
    expect(includes(week, 20260101) && !includes(week, 20260108), "half-open date range");

    const std::array rows{
        Transaction{20'000, 20251231, 1, OperationType::expense},
        Transaction{50'000, 20260101, 0, OperationType::expense},
        Transaction{80'000, 20260107, 1, OperationType::expense},
        Transaction{12'501, 20260107, 0, OperationType::expense},
        Transaction{50'000, 20260101, 1, OperationType::income},
        Transaction{10'000, 20260108, 0, OperationType::expense},
        Transaction{1, 20260103, -1, OperationType::expense},
    };
    Summary result{};
    expect(summarize({}, week, 0, result) == Status::ok && result.spent == 0 && result.percent == -1, "empty zero-budget summary");
    expect(summarize(rows, week, 142'502, result) == Status::ok && result.spent == 142'502 && result.income == 50'000 && result.remaining == 0 && result.percent == 100, "exact weekly limit and separate income");
    expect(summarize(rows, week, 100'000, result) == Status::ok && result.remaining == -42'502 && result.overrun == 42'502 && result.percent == 143, "weekly overrun and half-up percent");
    expect(summarize(rows, month, 300'000, result) == Status::ok && result.spent == 152'502 && result.remaining == 147'498 && result.percent == 51, "independent monthly spending and limit");
    expect(summarize(rows, week, -1, result) == Status::invalid_input, "negative limit rejected");

    const std::array excessive{
        Transaction{max, 20260101, 0, OperationType::expense},
        Transaction{1, 20260101, 0, OperationType::expense},
    };
    expect(summarize(excessive, week, 0, result) == Status::overflow, "transaction sum overflow");
    const std::array invalid{Transaction{-1, 20260101, 0, OperationType::expense}};
    expect(summarize(invalid, week, 10, result) == Status::invalid_input, "negative transaction rejected");

    std::array<Aggregate, 3> groups{};
    std::int32_t count{};
    expect(aggregate(rows, week, groups, count) == Status::ok && count == 2, "only used expense groups are returned");
    expect(groups[0].group == 1 && groups[0].amount == 80'000 && groups[1].group == 0 && groups[1].amount == 62'501, "groups combine expenses and sort by amount");
    expect(aggregate(excessive, week, groups, count) == Status::overflow, "group sum overflow");

    const std::array equal{
        Transaction{50, 20251231, 0, OperationType::expense},
        Transaction{50, 20260101, 1, OperationType::expense},
        Transaction{50, 20260101, 0, OperationType::expense},
    };
    expect(aggregate(equal, week, groups, count) == Status::ok && groups[0].group == 1 && groups[1].group == 0, "tied amounts retain first occurrence within the period");

    const std::array mixed{
        Transaction{10'000, 20260101, 0, OperationType::expense},
        Transaction{50'000, 20260102, 0, OperationType::expense, BudgetScope::weekly_and_monthly, 50'050},
        Transaction{25'000, 20260103, 1, OperationType::expense, BudgetScope::monthly_only},
        Transaction{100, 20260102, 2, OperationType::expense, BudgetScope::weekly_and_monthly, 0},
        Transaction{5'000, 20260104, 0, OperationType::income},
        Transaction{7'500, 20260108, 0, OperationType::expense},
    };
    expect(summarize(mixed, week, 70'000, result) == Status::ok && result.spent == 60'100 && result.actual_spent == 85'050 &&
           result.income == 5'000 && result.remaining == 9'900 && result.percent == 86, "weekly spending excludes monthly-only expenses and includes rounding");
    expect(summarize(mixed, month, 100'000, result) == Status::ok && result.spent == 92'600 && result.actual_spent == 92'550 &&
           result.income == 5'000 && result.remaining == 7'400 && result.percent == 93, "monthly spending includes all expenses and rounding");
    expect(aggregate(mixed, week, groups, count) == Status::ok && count == 2 && groups[0].group == 0 && groups[0].amount == 60'000 &&
           groups[1].group == 2 && groups[1].amount == 100, "weekly breakdown excludes monthly-only expenses");
    expect(aggregate(mixed, month, groups, count) == Status::ok && count == 3 && groups[0].group == 0 && groups[0].amount == 67'500 &&
           groups[1].group == 1 && groups[1].amount == 25'000 && groups[2].group == 2 && groups[2].amount == 100,
           "monthly breakdown includes all expenses and rounding");

    const std::array forecast_rows{
        Transaction{10'000, 20260101, 0, OperationType::expense},
        Transaction{50'100, 20260102, 0, OperationType::expense, BudgetScope::weekly_and_monthly, 50'050},
        Transaction{25'000, 20260103, 1, OperationType::expense, BudgetScope::monthly_only},
        Transaction{5'000, 20260104, 0, OperationType::expense},
        Transaction{60'000, 20260105, 0, OperationType::income},
        Transaction{70'000, 20260105, 0, OperationType::expense},
        Transaction{1, 20260106, 0, OperationType::expense},
        Transaction{7'500, 20260108, 0, OperationType::expense},
    };
    Forecast projection{};
    expect(forecast(forecast_rows, week, 20260104, 190'000, projection) == Status::ok &&
           projection.spent_to_date == 65'100 && projection.future_spent == 70'001 &&
           projection.projected_spent == 190'200 && projection.remaining == -200 &&
           projection.elapsed_days == 3 && projection.remaining_days == 4 &&
           projection.confidence == ForecastConfidence::standard, "forecast uses completed-day budget spending and includes known expenses once");
    expect(forecast(forecast_rows, week, 20260101, 100'000, projection) == Status::ok &&
           projection.spent_to_date == 10'000 && projection.future_spent == 125'101 &&
           projection.projected_spent == 135'101 && projection.remaining == -35'101 &&
           projection.elapsed_days == 0 && projection.remaining_days == 7 &&
           projection.confidence == ForecastConfidence::insufficient, "first day forecast reports the known lower bound only");
    expect(forecast({}, month, 20260108, 10, projection) == Status::ok &&
           projection.projected_spent == 0 && projection.remaining == 10 &&
           projection.confidence == ForecastConfidence::insufficient, "no activity leaves an unknown pace");
    const std::array leap_rows{
        Transaction{42, 20240201, 0, OperationType::expense, BudgetScope::monthly_only},
    };
    expect(period(20240229, PeriodKind::month, 4, 0, shifted) == Status::ok &&
           forecast(leap_rows, shifted, 20240229, 44, projection) == Status::ok &&
           projection.projected_spent == 44 && projection.remaining == 0 &&
           projection.elapsed_days == 28 && projection.remaining_days == 1 &&
           projection.confidence == ForecastConfidence::low, "leap month counts calendar days and rounds 1.5 kopecks up");
    expect(forecast(rows, week, week.end, 0, projection) == Status::invalid_input, "forecast excludes the next period's start");
    expect(forecast(invalid, week, 20260102, 0, projection) == Status::invalid_input, "forecast rejects invalid transaction amounts");
    const std::array large{Transaction{max, 20260101, 0, OperationType::expense}};
    expect(forecast(large, week, 20260101, max, projection) == Status::ok &&
           projection.projected_spent == max, "forecast preserves an exactly representable int64 total");
    expect(forecast(large, week, 20260107, max, projection) == Status::overflow &&
           projection.projected_spent == max, "forecast overflow leaves result unchanged");
}
