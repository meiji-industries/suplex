use chrono::{DateTime, SecondsFormat, Utc};

/// JavaScript `Date.prototype.toISOString`.
pub fn rfc3339_millis(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn now_millis_rfc3339() -> String {
    rfc3339_millis(Utc::now())
}
