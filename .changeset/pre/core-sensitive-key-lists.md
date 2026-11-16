---
"@strutvane/framework": patch
---

The default logger redacts more sensitive keys (`passphrase`, `salt`, `jwt`, `bearer`, `session`, `accessKey`, `signingKey`, `encryptionKey`, `totp`, `mfa`, `recoveryCode`, `backupCode`, `cardNumber`, `cvv`, `iban` and others), and short words such as `pin`, `ssn` and `otp` now match as whole words only. New exports: `DEFAULT_SENSITIVE_WORDS`, `normalizeSensitiveKey`, `registerSensitiveKeys` (add keys at runtime for every logger in the process) and the `SensitiveKeyMatcherOptions` type for `sensitiveKeyMatcher`.
