use alloc::string::String;

/// [`Keys`] error
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// Invalid public key
    InvalidPublicKey,
    /// Invalid event id
    InvalidEventId,
    /// Failed to validate signature against message and pubkey
    ValidationFail,
    /// Invalid signature format
    InvalidSignatureFormat,
    /// Unknown JSON event key
    UnknownKey(String),
    /// Error serializing or deserializing JSON data
    Json(String),
}
