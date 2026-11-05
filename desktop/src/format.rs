//! Display formatting and amount parsing. Pure functions; no GPUI.
//!
//! Coin amounts travel as integer base units (sats / litoshis, 10⁻⁸ of a coin). Parsing and
//! formatting are integer-only so `0.1 BTC` is exactly `10_000_000` sats — never a float.

/// Base units per coin (BTC and LTC both use 8 decimals).
pub const UNITS_PER_COIN: u64 = 100_000_000;
const DECIMALS: usize = 8;

/// `1234567` → `1,234,567`.
pub fn int(n: u128) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// `d2abf17309f9…` → `d2abf173…7fa5`.
pub fn short_hex(s: &str) -> String {
    if s.len() > 14 { format!("{}…{}", &s[..8], &s[s.len() - 4..]) } else { s.to_owned() }
}

/// Seconds → `45s`, `12m`, `3h`, `2d`.
pub fn ago(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m", secs / 60),
        3600..86_400 => format!("{}h", secs / 3600),
        _ => format!("{}d", secs / 86_400),
    }
}

/// Seconds → a rough human span: `under a minute`, `45 min`, `3h 20m`, `2d 4h`.
pub fn span(secs: u64) -> String {
    let mins = secs.div_ceil(60);
    match mins {
        0 => "under a minute".into(),
        1..60 => format!("{mins} min"),
        60..1440 => match mins % 60 {
            0 => format!("{}h", mins / 60),
            m => format!("{}h {m}m", mins / 60),
        },
        _ => match (mins % 1440) / 60 {
            0 => format!("{}d", mins / 1440),
            h => format!("{}d {h}h", mins / 1440),
        },
    }
}

/// Base units → coin string with exactly 8 decimals: `1_500_000` → `0.01500000`.
pub fn coin(units: u64) -> String {
    format!("{}.{:0width$}", units / UNITS_PER_COIN, units % UNITS_PER_COIN, width = DECIMALS)
}

/// Signed base units → coin string with 8 decimals and a sign when negative.
pub fn coin_signed(units: i64) -> String {
    let abs = coin(units.unsigned_abs());
    if units < 0 { format!("-{abs}") } else { abs }
}

/// Base units → the shortest exact coin string, for prefilling inputs: `1_500_000` → `0.015`.
pub fn coin_input(units: u64) -> String {
    let full = coin(units);
    let trimmed = full.trim_end_matches('0');
    trimmed.strip_suffix('.').unwrap_or(trimmed).to_owned()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AmountError {
    Empty,
    /// Anything other than digits and one decimal point.
    Invalid,
    /// More than 8 decimal places.
    TooPrecise,
    TooLarge,
}

impl AmountError {
    pub fn message(self) -> &'static str {
        match self {
            AmountError::Empty => "Enter an amount.",
            AmountError::Invalid => "Use digits and a decimal point, e.g. 0.015.",
            AmountError::TooPrecise => "At most 8 decimal places.",
            AmountError::TooLarge => "That amount is too large.",
        }
    }
}

/// Coin string (`"0.015"`, `"1"`, `".5"`, `"2."`) → base units, exactly. Surrounding whitespace
/// is ignored; signs, exponents, separators and more than 8 decimals are rejected.
pub fn parse_coin(input: &str) -> Result<u64, AmountError> {
    let s = input.trim();
    if s.is_empty() {
        return Err(AmountError::Empty);
    }
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    let digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    if (whole.is_empty() && frac.is_empty()) || !digits(whole) || !digits(frac) {
        return Err(AmountError::Invalid);
    }
    if frac.len() > DECIMALS {
        return Err(AmountError::TooPrecise);
    }
    let whole_units = if whole.is_empty() {
        0
    } else {
        whole.parse::<u64>().map_err(|_| AmountError::TooLarge)?.checked_mul(UNITS_PER_COIN).ok_or(AmountError::TooLarge)?
    };
    let frac_units = if frac.is_empty() { 0 } else { frac.parse::<u64>().map_err(|_| AmountError::Invalid)? * 10u64.pow((DECIMALS - frac.len()) as u32) };
    whole_units.checked_add(frac_units).ok_or(AmountError::TooLarge)
}

/// `num / den` as an 8-decimal coin string, rounded down: the price of one unit of `den`'s coin
/// in `num`'s coin. `None` when `den` is zero.
pub fn ratio(num: u64, den: u64) -> Option<String> {
    if den == 0 {
        return None;
    }
    let scaled = (num as u128) * (UNITS_PER_COIN as u128) / (den as u128);
    let whole = scaled / UNITS_PER_COIN as u128;
    let frac = scaled % UNITS_PER_COIN as u128;
    Some(format!("{whole}.{frac:0width$}", width = DECIMALS))
}

/// The want-leg owed for a fill of `fill` give-units: `floor(fill × want / give)` (the fold's
/// `proRata`). Zero when `give` is zero.
pub fn pro_rata(fill: u64, give: u64, want: u64) -> u64 {
    if give == 0 {
        return 0;
    }
    ((fill as u128) * (want as u128) / (give as u128)) as u64
}

/// `takerLock` / `taker_lock` → `Taker lock`.
pub fn humanize(kind: &str) -> String {
    let mut out = String::with_capacity(kind.len() + 4);
    for (i, ch) in kind.chars().enumerate() {
        if ch == '_' || ch == '-' {
            out.push(' ');
        } else if ch.is_ascii_uppercase() && i > 0 {
            out.push(' ');
            out.push(ch.to_ascii_lowercase());
        } else if i == 0 {
            out.push(ch.to_ascii_uppercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn int_groups_thousands() {
        assert_eq!(int(0), "0");
        assert_eq!(int(999), "999");
        assert_eq!(int(1000), "1,000");
        assert_eq!(int(1234567), "1,234,567");
    }

    #[test]
    fn parse_coin_is_exact() {
        assert_eq!(parse_coin("0.1"), Ok(10_000_000));
        assert_eq!(parse_coin("0.3"), Ok(30_000_000));
        assert_eq!(parse_coin("1"), Ok(100_000_000));
        assert_eq!(parse_coin("1."), Ok(100_000_000));
        assert_eq!(parse_coin(".5"), Ok(50_000_000));
        assert_eq!(parse_coin("0.00000001"), Ok(1));
        assert_eq!(parse_coin("1.23456789"), Ok(123_456_789));
        assert_eq!(parse_coin("0.015"), Ok(1_500_000));
        assert_eq!(parse_coin("  2.5 "), Ok(250_000_000));
        assert_eq!(parse_coin("000.10"), Ok(10_000_000));
        assert_eq!(parse_coin("21000000"), Ok(2_100_000_000_000_000));
        assert_eq!(parse_coin("84000000"), Ok(8_400_000_000_000_000));
        assert_eq!(parse_coin("0"), Ok(0));
    }

    #[test]
    fn parse_coin_rejects_bad_input() {
        assert_eq!(parse_coin(""), Err(AmountError::Empty));
        assert_eq!(parse_coin("   "), Err(AmountError::Empty));
        assert_eq!(parse_coin("."), Err(AmountError::Invalid));
        assert_eq!(parse_coin("-1"), Err(AmountError::Invalid));
        assert_eq!(parse_coin("+1"), Err(AmountError::Invalid));
        assert_eq!(parse_coin("1e-8"), Err(AmountError::Invalid));
        assert_eq!(parse_coin("1,000"), Err(AmountError::Invalid));
        assert_eq!(parse_coin("1.2.3"), Err(AmountError::Invalid));
        assert_eq!(parse_coin("1 000"), Err(AmountError::Invalid));
        assert_eq!(parse_coin("abc"), Err(AmountError::Invalid));
        assert_eq!(parse_coin("0.000000001"), Err(AmountError::TooPrecise));
        assert_eq!(parse_coin("184467440737.09551616"), Err(AmountError::TooLarge));
        assert_eq!(parse_coin("99999999999999999999"), Err(AmountError::TooLarge));
    }

    #[test]
    fn coin_formats_eight_decimals() {
        assert_eq!(coin(0), "0.00000000");
        assert_eq!(coin(1), "0.00000001");
        assert_eq!(coin(1_500_000), "0.01500000");
        assert_eq!(coin(123_456_789), "1.23456789");
        assert_eq!(coin(2_100_000_000_000_000), "21000000.00000000");
        assert_eq!(coin_signed(-5_000), "-0.00005000");
        assert_eq!(coin_signed(5_000), "0.00005000");
    }

    #[test]
    fn coin_round_trips() {
        for units in [0, 1, 9, 10, 330, 3_300, 1_500_000, 10_000_000, 123_456_789, 100_000_000, u64::MAX] {
            assert_eq!(parse_coin(&coin(units)), Ok(units), "{units}");
            assert_eq!(parse_coin(&coin_input(units)), Ok(units), "{units}");
        }
        assert_eq!(coin_input(1_500_000), "0.015");
        assert_eq!(coin_input(100_000_000), "1");
        assert_eq!(coin_input(0), "0");
    }

    #[test]
    fn ratio_and_pro_rata_round_down() {
        // 0.01 BTC for 1.2 LTC: 1 BTC = 120 LTC, 1 LTC = 0.00833333 BTC.
        assert_eq!(ratio(120_000_000, 1_000_000).as_deref(), Some("120.00000000"));
        assert_eq!(ratio(1_000_000, 120_000_000).as_deref(), Some("0.00833333"));
        assert_eq!(ratio(1, 0), None);
        assert_eq!(pro_rata(500_000, 1_000_000, 120_000_000), 60_000_000);
        assert_eq!(pro_rata(1, 3, 2), 0);
        assert_eq!(pro_rata(u64::MAX, u64::MAX, u64::MAX), u64::MAX);
        assert_eq!(pro_rata(5, 0, 10), 0);
    }

    #[test]
    fn span_and_humanize() {
        assert_eq!(span(0), "under a minute");
        assert_eq!(span(30), "1 min");
        assert_eq!(span(45 * 60), "45 min");
        assert_eq!(span(3600), "1h");
        assert_eq!(span(200 * 60), "3h 20m");
        assert_eq!(span(86_400 * 2 + 4 * 3600), "2d 4h");
        assert_eq!(humanize("takerLock"), "Taker lock");
        assert_eq!(humanize("refund_window"), "Refund window");
        assert_eq!(humanize("proofs"), "Proofs");
    }
}
