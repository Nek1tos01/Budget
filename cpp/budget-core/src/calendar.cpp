#include "budget_core.hpp"

#include <chrono>

namespace budget {
namespace {

using namespace std::chrono;

constexpr year_month_day decode_day(Day date) {
    return year{date / 10'000} / static_cast<unsigned>(date / 100 % 100)
        / static_cast<unsigned>(date % 100);
}

constexpr Day encode_day(year_month_day date) {
    return int{date.year()} * 10'000 + int(unsigned{date.month()}) * 100 + int(unsigned{date.day()});
}

constexpr sys_days first_day = year{0} / January / 1;
constexpr sys_days last_day = year{9999} / December / 31;

} // namespace

bool valid_day(Day date) {
    return date >= 101 && date <= 99'991'231 && decode_day(date).ok();
}

std::int32_t days_between(Day start, Day end) {
    return static_cast<std::int32_t>((sys_days{decode_day(end)} - sys_days{decode_day(start)}).count());
}

Status period(Day today, PeriodKind kind, int week_start, int offset, BudgetPeriod& result) {
    if (!valid_day(today) || week_start < 1 || week_start > 7) return Status::invalid_input;
    const auto current = decode_day(today);
    if (kind == PeriodKind::week) {
        const auto current_day = sys_days{current};
        const auto week_day = weekday{current_day}.iso_encoding();
        const auto since_start = (static_cast<int>(week_day) - week_start + 7) % 7;
        const std::int64_t shift = std::int64_t{offset} * 7 - since_start;
        if (shift < (first_day - current_day).count() ||
            shift + 7 > (last_day - current_day).count()) return Status::invalid_input;
        const auto start = current_day + days{static_cast<days::rep>(shift)};
        result = {encode_day(year_month_day{start}), encode_day(year_month_day{start + days{7}}), kind};
        return Status::ok;
    }
    if (kind != PeriodKind::month) return Status::invalid_input;
    // The end of a period is exclusive and must likewise fit in YYYYMMDD.
    const auto month_index = std::int64_t{int{current.year()}} * 12 + unsigned{current.month()} - 1 + offset;
    if (month_index < 0 || month_index >= 9999 * 12 + 11) return Status::invalid_input;
    const auto start = year{static_cast<int>(month_index / 12)} /
        static_cast<unsigned>(month_index % 12 + 1) / 1;
    result = {encode_day(start), encode_day(start + months{1}), kind};
    return Status::ok;
}

bool includes(BudgetPeriod range, Day date) {
    return date >= range.start && date < range.end;
}

} // namespace budget
