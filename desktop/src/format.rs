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
}
