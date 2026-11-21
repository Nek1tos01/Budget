#include "budget_core.hpp"

#include <cstddef>

using namespace budget;

// Wire layouts are read with explicit little-endian offsets in budget-wasm.ts.
static_assert(sizeof(BudgetPeriod) == 12 && offsetof(BudgetPeriod, end) == 4 && offsetof(BudgetPeriod, kind) == 8);
static_assert(sizeof(Transaction) == 32 && offsetof(Transaction, date) == 8 &&
              offsetof(Transaction, group) == 12 && offsetof(Transaction, type) == 16 &&
              offsetof(Transaction, budget_scope) == 20 && offsetof(Transaction, actual_amount) == 24);
static_assert(sizeof(Summary) == 48 && offsetof(Summary, income) == 8 &&
              offsetof(Summary, remaining) == 16 && offsetof(Summary, overrun) == 24 &&
              offsetof(Summary, percent) == 32 && offsetof(Summary, actual_spent) == 40);
static_assert(sizeof(Forecast) == 48 && offsetof(Forecast, future_spent) == 8 &&
              offsetof(Forecast, projected_spent) == 16 && offsetof(Forecast, remaining) == 24 &&
              offsetof(Forecast, elapsed_days) == 32 && offsetof(Forecast, remaining_days) == 36 &&
              offsetof(Forecast, confidence) == 40 && offsetof(Forecast, risk) == 44);
static_assert(sizeof(Aggregate) == 16 && offsetof(Aggregate, group) == 8);

extern "C" {

std::int32_t budget_period(Day today, PeriodKind kind, int week_start, int offset, BudgetPeriod* result) {
    return static_cast<std::int32_t>(period(today, kind, week_start, offset, *result));
}

std::int32_t budget_includes(Day start, Day end, Day date) {
    return includes({start, end}, date);
}

std::int32_t budget_add(Money left, Money right, Money* result) {
    return static_cast<std::int32_t>(add_money(left, right, *result));
}

std::int32_t budget_round_up_to_ruble(Money amount, Money* result) {
    return static_cast<std::int32_t>(round_up_to_ruble(amount, *result));
}

std::int32_t budget_usage_percent(Money part, Money total, std::int64_t* result) {
    return static_cast<std::int32_t>(usage_percent(part, total, *result));
}

std::int32_t budget_percent_change(Money current, Money previous, std::int64_t* result) {
    return static_cast<std::int32_t>(percent_change(current, previous, *result));
}

std::int32_t budget_summary(const Transaction* rows, std::uint32_t size, Day start, Day end,
                            PeriodKind kind, Money limit, Summary* result) {
    return static_cast<std::int32_t>(summarize({rows, size}, {start, end, kind}, limit, *result));
}

std::int32_t budget_forecast(const Transaction* rows, std::uint32_t size, Day start, Day end,
                             PeriodKind kind, Day today, Money limit, Forecast* result) {
    return static_cast<std::int32_t>(forecast({rows, size}, {start, end, kind}, today, limit, *result));
}

// Returns the number of groups written, or a negated error code.
std::int32_t budget_breakdown(const Transaction* rows, std::uint32_t size, Day start, Day end,
                              PeriodKind kind, Aggregate* groups, std::uint32_t group_count) {
    std::int32_t count{};
    const auto status = aggregate({rows, size}, {start, end, kind}, {groups, group_count}, count);
    return status == Status::ok ? count : -static_cast<std::int32_t>(status);
}

}
