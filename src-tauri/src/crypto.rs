//! 主密码加密：PBKDF2 派生密钥 + AES-256-GCM 加密会话密码字段。
//! 密文格式：`enc:v1:{nonce_hex}:{ciphertext_hex}`（salt 全局存于 app_settings）

use std::num::NonZeroU32;

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::pbkdf2;

const PBKDF2_ITER: u32 = 120_000;
const PREFIX: &str = "enc:v1:";
const VERIFY_PLAINTEXT: &str = "termix-master-verify";

pub type MasterKey = [u8; 32];

/// 从主密码与盐派生 32 字节密钥（PBKDF2-HMAC-SHA256）
pub fn derive_key(master: &str, salt: &[u8]) -> MasterKey {
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(PBKDF2_ITER).unwrap(),
        salt,
        master.as_bytes(),
        &mut key,
    );
    key
}

/// 基于 uuid v4 生成随机字节（无额外 RNG 依赖）
fn rand_bytes(len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        out.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    out.truncate(len);
    out
}

pub fn gen_salt() -> Vec<u8> {
    rand_bytes(16)
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn from_hex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("invalid hex".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// 加密明文，返回 `enc:v1:nonce:ciphertext`
pub fn encrypt(key: &MasterKey, plain: &str) -> String {
    let unbound = UnboundKey::new(&AES_256_GCM, key).expect("valid key length");
    let seal = LessSafeKey::new(unbound);
    let nonce = rand_bytes(NONCE_LEN);
    let mut nonce_arr = [0u8; NONCE_LEN];
    nonce_arr.copy_from_slice(&nonce);
    let mut buf = plain.as_bytes().to_vec();
    seal.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_arr),
        Aad::empty(),
        &mut buf,
    )
    .expect("seal should succeed");
    format!("{PREFIX}{}:{}", to_hex(&nonce_arr), to_hex(&buf))
}

/// 解密 `enc:v1:...`，失败返回错误（主密码错误或数据损坏）
pub fn decrypt(key: &MasterKey, s: &str) -> Result<String, String> {
    let parts: Vec<&str> = s.splitn(4, ':').collect();
    if parts.len() != 4 || parts[0] != "enc" || parts[1] != "v1" {
        return Err("invalid encrypted format".into());
    }
    let nonce = from_hex(parts[2])?;
    if nonce.len() != NONCE_LEN {
        return Err("invalid nonce length".into());
    }
    let mut nonce_arr = [0u8; NONCE_LEN];
    nonce_arr.copy_from_slice(&nonce);
    let mut ct = from_hex(parts[3])?;
    let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|e| e.to_string())?;
    let seal = LessSafeKey::new(unbound);
    let pt = seal
        .open_in_place(
            Nonce::assume_unique_for_key(nonce_arr),
            Aad::empty(),
            &mut ct,
        )
        .map_err(|_| "解密失败：主密码错误或数据已损坏".to_string())?;
    String::from_utf8(pt.to_vec()).map_err(|e| e.to_string())
}

pub fn is_encrypted(s: &str) -> bool {
    s.starts_with(PREFIX)
}

/// 生成校验密文（用于验证主密码正确性）
pub fn make_verify(key: &MasterKey) -> String {
    encrypt(key, VERIFY_PLAINTEXT)
}

/// 校验主密码是否与校验密文匹配
pub fn verify_master(key: &MasterKey, verify_ct: &str) -> bool {
    decrypt(key, verify_ct).map(|p| p == VERIFY_PLAINTEXT).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = derive_key("my-master-pass", b"somesalt12345678");
        let ct = encrypt(&key, "secret-password");
        assert!(ct.starts_with("enc:v1:"));
        assert_eq!(decrypt(&key, &ct).unwrap(), "secret-password");
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let key = derive_key("pass-a", b"salt");
        let ct = encrypt(&key, "data");
        let wrong = derive_key("pass-b", b"salt");
        assert!(decrypt(&wrong, &ct).is_err());
    }

    #[test]
    fn decrypt_malformed_fails() {
        let key = derive_key("p", b"s");
        assert!(decrypt(&key, "plain-text").is_err());
        assert!(decrypt(&key, "enc:v1:zz").is_err());
    }

    #[test]
    fn is_encrypted_detects() {
        assert!(is_encrypted("enc:v1:abcd"));
        assert!(!is_encrypted("plain"));
        assert!(!is_encrypted(""));
    }

    #[test]
    fn verify_master_roundtrip() {
        let key = derive_key("p", b"s");
        let v = make_verify(&key);
        assert!(verify_master(&key, &v));
        let other = derive_key("q", b"s");
        assert!(!verify_master(&other, &v));
    }
}
