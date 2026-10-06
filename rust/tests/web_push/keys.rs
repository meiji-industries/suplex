#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_form_round_trips_and_signs_pushes() {
        let key = VapidKey::generate();
        let stored = key.to_base64url();
        let restored = VapidKey::from_base64url(&stored).unwrap();
        assert_eq!(restored.to_base64url(), stored);
        assert_eq!(restored.public_base64url(), key.public_base64url());
        let public = decode_base64url(&key.public_base64url()).unwrap();
        assert_eq!((public.len(), public[0]), (65, 0x04));
        let subscriber = VapidKey::generate();
        let subscription = web_push::SubscriptionInfo::new(
            "https://web.push.apple.com/QOkf8".to_string(),
            subscriber.public_base64url(),
            URL_SAFE_NO_PAD.encode([7u8; 16]),
        );
        let signature = web_push::VapidSignatureBuilder::from_base64(&stored, &subscription).unwrap();
        assert!(signature.build().is_ok());
        assert!(VapidKey::from_base64url("not a key").is_err());
    }
}
