//! Display formatting. Pure functions; no GPUI.

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

/// A gBTC amount (integer sats-denominated units) for display.
pub fn gbtc(n: u128) -> String {
    format!("{} gBTC", int(n))
}

/// Integer price × 10^expo → `$64,721.36`. `None` for a missing/malformed price.
pub fn usd(price: &str, expo: i32) -> Option<String> {
    let raw: i128 = price.trim().parse().ok()?;
    let negative = raw < 0;
    let raw = raw.unsigned_abs();
    // Round to cents exactly in integer space.
    let cents: u128 = if expo >= -2 {
        raw * 10u128.pow((expo + 2) as u32)
    } else {
        let div = 10u128.pow((-expo - 2) as u32);
        (raw + div / 2) / div
    };
    Some(format!("{}${}.{:02}", if negative { "-" } else { "" }, int(cents / 100), cents % 100))
}

/// `d2abf17309f9…` → `d2abf173…7fa5`.
pub fn short_hex(s: &str) -> String {
    if s.len() > 14 { format!("{}…{}", &s[..8], &s[s.len() - 4..]) } else { s.to_owned() }
}

/// Seconds → `4:05`, or `1:02:03` past an hour.
pub fn clock(secs: u64) -> String {
    let (h, m, s) = (secs / 3600, (secs / 60) % 60, secs % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
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

/// What a winning stake pays per 1 staked under pure parimutuel: `1 + other / mine`.
pub fn payout_multiple(mine: u128, other: u128) -> Option<f64> {
    (mine > 0).then(|| 1.0 + other as f64 / mine as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usd_rounds_to_cents_across_exponents() {
        assert_eq!(usd("6472136139157", -8).as_deref(), Some("$64,721.36"));
        assert_eq!(usd("6472136500000", -8).as_deref(), Some("$64,721.37"));
        assert_eq!(usd("999999", -6).as_deref(), Some("$1.00"));
        assert_eq!(usd("12", 0).as_deref(), Some("$12.00"));
        assert_eq!(usd("5", -1).as_deref(), Some("$0.50"));
        assert_eq!(usd("nope", -8), None);
    }

    #[test]
    fn int_groups_thousands() {
        assert_eq!(int(0), "0");
        assert_eq!(int(999), "999");
        assert_eq!(int(1000), "1,000");
        assert_eq!(int(1234567), "1,234,567");
    }
}
