#pragma once

#include <cstdint>
#include <span>

namespace budget {

using Money = std::int64_t;
using Day = std::int32_t; // Gregorian YYYYMMDD

enum class Status : std::int32_t { ok = 0, invalid_input = 1, overflow = 2 };
enum class PeriodKind : std::int32_t { week = 0, month = 1 };
enum class OperationType : std::int32_t { expense = 0, income = 1 };
enum class BudgetScope : std::int32_t { weekly_and_monthly = 0, monthly_only = 1 };
enum class ForecastConfidence : std::int32_t { insufficient = 0, low = 1, standard = 2 };
enum class ForecastRisk : std::int32_t { unknown = 0, within_limit = 1, over_limit = 2 };

struct BudgetPeriod {
    Day start;
    Day end;
    PeriodKind kind{PeriodKind::week};
};

// The adapter maps category/member IDs to dense group indexes. -1 means no group.
struct Transaction {
    Money amount;
    Day date;
    std::int32_t group;
    OperationType type;
    BudgetScope budget_scope{BudgetScope::weekly_and_monthly};
    Money actual_amount{amount};
};

struct Summary {
    Money spent;
    Money income;
    Money remaining;
    Money overrun;
    std::int64_t percent; // -1 means the limit is zero
    Money actual_spent;
};

struct Forecast {
    Money spent_to_date;
    Money future_spent;
    Money projected_spent;
    Money remaining;
    std::int32_t elapsed_days;
    std::int32_t remaining_days; // Includes today.
    ForecastConfidence confidence;
    ForecastRisk risk;
};

struct Aggregate {
    Money amount;
    std::int32_t group;
    std::int32_t first_row;
};

Status add_money(Money left, Money right, Money& result);
Status subtract_money(Money left, Money right, Money& result);
Status round_up_to_ruble(Money amount, Money& result);
Status usage_percent(Money part, Money total, std::int64_t& result);
Status percent_change(Money current, Money previous, std::int64_t& result);

bool valid_day(Day date);
// Both endpoints must be valid Gregorian days.
std::int32_t days_between(Day start, Day end);
Status period(Day today, PeriodKind kind, int week_start, int offset, BudgetPeriod& result);
bool includes(BudgetPeriod range, Day date);

Status summarize(std::span<const Transaction> rows, BudgetPeriod range, Money limit, Summary& result);
Status forecast(std::span<const Transaction> rows, BudgetPeriod range, Day today, Money limit, Forecast& result);
Status aggregate(std::span<const Transaction> rows, BudgetPeriod range,
                 std::span<Aggregate> groups, std::int32_t& count);

} // namespace budget
