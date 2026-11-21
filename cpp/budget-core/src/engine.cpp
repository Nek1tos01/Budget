#include "budget_core.hpp"

#include <algorithm>
#include <array>
#include <limits>

namespace budget {
namespace {

bool valid_range(BudgetPeriod range) {
    return range.start < range.end && valid_day(range.start) && valid_day(range.end) &&
        (range.kind == PeriodKind::week || range.kind == PeriodKind::month);
}

bool valid_row(const Transaction& row) {
    return row.amount >= 0 && row.actual_amount >= 0 && valid_day(row.date) &&
        (row.type == OperationType::expense || row.type == OperationType::income) &&
        (row.budget_scope == BudgetScope::weekly_and_monthly || row.budget_scope == BudgetScope::monthly_only);
}

bool counts_toward_budget(const Transaction& row, BudgetPeriod range) {
    return range.kind == PeriodKind::month || row.budget_scope == BudgetScope::weekly_and_monthly;
}

} // namespace

Status summarize(std::span<const Transaction> rows, BudgetPeriod range, Money limit, Summary& result) {
    if (limit < 0 || !valid_range(range)) return Status::invalid_input;
    Summary calculated{};
    for (const auto& row : rows) {
        if (!valid_row(row)) return Status::invalid_input;
        if (!includes(range, row.date)) continue;
        if (row.type == OperationType::income) {
            if (auto status = add_money(calculated.income, row.amount, calculated.income);
                status != Status::ok) return status;
            continue;
        }
        if (auto status = add_money(calculated.actual_spent, row.actual_amount, calculated.actual_spent);
            status != Status::ok) return status;
        if (counts_toward_budget(row, range)) {
            if (auto status = add_money(calculated.spent, row.amount, calculated.spent);
                status != Status::ok) return status;
        }
    }
    // Both operands are nonnegative int64, so the difference and its negation fit.
    calculated.remaining = limit - calculated.spent;
    calculated.overrun = std::max(Money{0}, -calculated.remaining);
    calculated.percent = -1;
    if (limit != 0) {
        if (auto status = usage_percent(calculated.spent, limit, calculated.percent);
            status != Status::ok) return status;
    }
    result = calculated;
    return Status::ok;
}

Status forecast(std::span<const Transaction> rows, BudgetPeriod range, Day today, Money limit, Forecast& result) {
    if (limit < 0 || !valid_range(range) || !valid_day(today) || !includes(range, today)) {
        return Status::invalid_input;
    }
    constexpr std::int32_t max_days = 31;
    const auto period_days = days_between(range.start, range.end);
    if (period_days > max_days) return Status::invalid_input;

    Forecast calculated{};
    calculated.elapsed_days = days_between(range.start, today);
    calculated.remaining_days = period_days - calculated.elapsed_days;
    std::array<Money, max_days> daily_spending{};
    for (const auto& row : rows) {
        if (!valid_row(row)) return Status::invalid_input;
        if (row.type != OperationType::expense || !includes(range, row.date) ||
            !counts_toward_budget(row, range)) continue;
        auto& daily_total = daily_spending[days_between(range.start, row.date)];
        if (auto status = add_money(daily_total, row.amount, daily_total); status != Status::ok) return status;
    }

    Money completed_spending{};
    std::int32_t spending_days{};
    for (auto day = 0; day < calculated.elapsed_days; ++day) {
        const auto amount = daily_spending[day];
        if (amount > 0) ++spending_days;
        if (auto status = add_money(completed_spending, amount, completed_spending);
            status != Status::ok) return status;
    }
    if (auto status = add_money(completed_spending, daily_spending[calculated.elapsed_days], calculated.spent_to_date);
        status != Status::ok) return status;

    // Only completed days inform the pace. Keep its fractional kopecks until
    // the final rounding, and let known expenses cover the estimate for their day.
    const auto divisor = std::max(1, calculated.elapsed_days);
    const auto daily_whole = completed_spending / divisor;
    const auto daily_remainder = completed_spending % divisor;
    Money remainder{};
    calculated.projected_spent = completed_spending;
    for (auto day = calculated.elapsed_days; day < period_days; ++day) {
        const auto known = daily_spending[day];
        if (day > calculated.elapsed_days) {
            if (auto status = add_money(calculated.future_spent, known, calculated.future_spent);
                status != Status::ok) return status;
        }
        if (known <= daily_whole) remainder += daily_remainder;
        if (auto status = add_money(calculated.projected_spent, std::max(known, daily_whole), calculated.projected_spent);
            status != Status::ok) return status;
    }
    if (auto status = add_money(calculated.projected_spent, (remainder + divisor / 2) / divisor, calculated.projected_spent);
        status != Status::ok) return status;

    calculated.remaining = limit - calculated.projected_spent;
    calculated.confidence = ForecastConfidence::insufficient;
    if (completed_spending > 0) {
        calculated.confidence = calculated.elapsed_days >= 3 && spending_days >= 2
            ? ForecastConfidence::standard : ForecastConfidence::low;
    }
    calculated.risk = ForecastRisk::unknown;
    if (calculated.remaining < 0) calculated.risk = ForecastRisk::over_limit;
    else if (calculated.confidence != ForecastConfidence::insufficient) calculated.risk = ForecastRisk::within_limit;
    result = calculated;
    return Status::ok;
}

Status aggregate(std::span<const Transaction> rows, BudgetPeriod range,
                 std::span<Aggregate> groups, std::int32_t& count) {
    constexpr auto max_count = std::numeric_limits<std::int32_t>::max();
    if (!valid_range(range) || rows.size() > max_count || groups.size() > max_count) {
        return Status::invalid_input;
    }
    std::fill(groups.begin(), groups.end(), Aggregate{0, -1, -1});
    for (std::size_t index = 0; index < rows.size(); ++index) {
        const auto& row = rows[index];
        if (!valid_row(row) || row.group < -1 ||
            (row.group >= 0 && static_cast<std::size_t>(row.group) >= groups.size())) {
            return Status::invalid_input;
        }
        if (row.group == -1 || row.type != OperationType::expense ||
            !includes(range, row.date) || !counts_toward_budget(row, range)) continue;
        auto& group = groups[row.group];
        if (group.first_row == -1) {
            group.group = row.group;
            group.first_row = static_cast<std::int32_t>(index);
        }
        if (auto status = add_money(group.amount, row.amount, group.amount); status != Status::ok) return status;
    }
    const auto end = std::remove_if(groups.begin(), groups.end(), [](const Aggregate& group) {
        return group.first_row == -1;
    });
    std::sort(groups.begin(), end, [](const Aggregate& left, const Aggregate& right) {
        if (left.amount != right.amount) return left.amount > right.amount;
        return left.first_row < right.first_row;
    });
    count = static_cast<std::int32_t>(end - groups.begin());
    return Status::ok;
}

} // namespace budget
