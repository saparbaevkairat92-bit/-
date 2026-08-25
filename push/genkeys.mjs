/* Генерация пары ключей VAPID.
   Запуск:  node genkeys.mjs
   ПРИВАТНЫЙ ключ НИКОГДА не коммить — он идёт в секреты Cloudflare. */
import { webcrypto as crypto } from "node:crypto";

const b64url=(buf)=>Buffer.from(buf).toString("base64")
  .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");

const pair=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
const pubRaw=await crypto.subtle.exportKey("raw",pair.publicKey);
const privJwk=await crypto.subtle.exportKey("jwk",pair.privateKey);
delete privJwk.key_ops; delete privJwk.ext;

console.log("\n=== ПУБЛИЧНЫЙ КЛЮЧ (можно хранить открыто) ===");
console.log("VAPID_PUBLIC_KEY =", b64url(pubRaw));
console.log("\n=== ПРИВАТНЫЙ КЛЮЧ (СЕКРЕТ, не коммить!) ===");
console.log(JSON.stringify(privJwk));
console.log("\nДальше:");
console.log("  1) впиши публичный ключ в wrangler.toml -> VAPID_PUBLIC_KEY");
console.log("  2) npx wrangler secret put VAPID_PRIVATE_JWK   (вставь строку JSON выше)\n");
