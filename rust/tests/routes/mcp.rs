#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_canonical_host_and_origin_decide_request_authority() {
        let reachable = "https://suplex.example.test:4111";
        assert!(authority_allowed(
            reachable,
            Some("SUPLEX.example.test:4111"),
            None
        ));
        assert!(authority_allowed(
            reachable,
            Some("suplex.example.test:4111"),
            Some(reachable)
        ));
        assert!(!authority_allowed(reachable, Some("attacker.test"), None));
        assert!(!authority_allowed(
            reachable,
            Some("suplex.example.test:4111"),
            Some("https://attacker.test")
        ));
        assert!(!authority_allowed(reachable, None, None));
    }
}
