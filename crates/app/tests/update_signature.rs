//! Update artifacts are only accepted when their minisign signature verifies
//! against the public key shipped with the application.

use minisign_verify::{PublicKey, Signature};

const CONTENT: &[u8] = b"beebranch update fixture v1\n";
const SIGNATURE: &str = concat!(
    "untrusted comment: signature from tauri secret key
",
    "RUQK0t+sEyMIDXIxln1NpPcPo40kcH1jtoP/bGncaFJNdBK/snfRsVUSuzl5Tl5PrHAZ2kAhCYtT50vynCz41rA1mTB7om02yQs=
",
    "trusted comment: timestamp:1793116590	file:beebranch-update-fixture.txt
",
    "T1gZYaf/8DDWJhgU0serxlcKm4yYok20muXhX17JyiJbTKMP5khwTMdIW1Xt5tblQZwauiRbyCjjnsjGf6zNDQ==
",
);

fn public_key() -> PublicKey {
    PublicKey::from_base64("RWQK0t+sEyMIDc0YSfEh4GGhUUdAE4gLfL+vGEMeiQWijLWkmpn/8MRc")
        .expect("public key")
}

#[test]
fn a_signed_artifact_is_accepted() {
    let signature = Signature::decode(SIGNATURE).expect("signature");
    public_key()
        .verify(CONTENT, &signature, false)
        .expect("signature must verify");
}

#[test]
fn a_tampered_or_unsigned_artifact_is_refused() {
    let signature = Signature::decode(SIGNATURE).expect("signature");
    let tampered = b"beebranch update fixture v1\n; inject";
    assert!(
        public_key().verify(tampered, &signature, false).is_err(),
        "tampered bytes must be refused"
    );
    assert!(
        Signature::decode("unsigned").is_err(),
        "an unsigned artifact has no valid signature to verify"
    );
}
