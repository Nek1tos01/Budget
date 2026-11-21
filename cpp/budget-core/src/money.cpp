#include "budget_core.hpp"

#include <limits>

namespace budget {
namespace {

constexpr auto max_money = std::numeric_limits<Money>::max();
constexpr auto min_money = std::numeric_limits<Money>::min();

// Each remainder stays below the denominator. This computes 100 * numerator /
// denominator without floating-point arithmetic or a nonportable 128-bit type.
Status rounded_percent(std::uint64_t numerator, std::uint64_t denominator,
                       bool negative, std::int64_t& result) {
    const auto whole = numerator / denominator;
    const auto step = numerator % denominator;
    if (whole > static_cast<std::uint64_t>(max_money) / 100) return Status::overflow;

    unsigned fractional = 0;
    std::uint64_t remainder = 0;
    if (step != 0) {
        for (unsigned i = 0; i < 100; ++i) {
            remainder += step;
            if (remainder >= denominator) {
                remainder -= denominator;
                ++fractional;
            }
        }
    }
    // Preserve Math.round behavior at ties, including negative changes.
    if (remainder > denominator - remainder ||
        (!negative && remainder == denominator - remainder)) {
        ++fractional;
    }
    const auto magnitude = whole * 100 + fractional;
    if (magnitude > static_cast<std::uint64_t>(max_money)) return Status::overflow;
    result = negative ? -static_cast<std::int64_t>(magnitude) : static_cast<std::int64_t>(magnitude);
    return Status::ok;
}

} // namespace

Status add_money(Money left, Money right, Money& result) {
    if ((right > 0 && left > max_money - right) ||
        (right < 0 && left < min_money - right)) return Status::overflow;
    result = left + right;
    return Status::ok;
}

Status subtract_money(Money left, Money right, Money& result) {
    if ((right > 0 && left < min_money + right) ||
        (right < 0 && left > max_money + right)) return Status::overflow;
    result = left - right;
    return Status::ok;
}

Status round_up_to_ruble(Money amount, Money& result) {
    if (amount < 0) return Status::invalid_input;
    constexpr Money kopecks_per_ruble = 100;
    const auto remainder = amount % kopecks_per_ruble;
    return add_money(amount, remainder == 0 ? 0 : kopecks_per_ruble - remainder, result);
}

Status usage_percent(Money part, Money total, std::int64_t& result) {
    if (part < 0 || total < 0) return Status::invalid_input;
    if (total == 0) {
        result = 0;
        return Status::ok;
    }
    return rounded_percent(part, total, false, result);
}

Status percent_change(Money current, Money previous, std::int64_t& result) {
    if (current < 0 || previous < 0) return Status::invalid_input;
    if (previous == 0) {
        result = 0;
        return Status::ok;
    }
    const bool negative = current < previous;
    const auto magnitude = negative ? previous - current : current - previous;
    return rounded_percent(magnitude, previous, negative, result);
}

} // namespace budget
