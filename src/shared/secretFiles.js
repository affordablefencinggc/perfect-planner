// Files that commonly hold credentials. Folder intake lists them as skipped and never opens,
// reads or hashes them. Templates (.env.example) and public keys (.pub) stay readable.
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist|defaults)$/i;
const SECRET_EXTENSIONS = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;
const SSH_PRIVATE_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i;

export function isSecretFileName(name) {
  const value = String(name ?? "");
  if (/^\.env(?:\..+)?$/i.test(value)) return !ENV_TEMPLATE.test(value);
  return SECRET_EXTENSIONS.test(value) || SSH_PRIVATE_KEY.test(value);
}
