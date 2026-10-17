// Prints a PBKDF2 hash of a password read from stdin, for ADMIN_PASSWORD:
//
//   node herald/hash-password.mjs
//   (type the password, Enter, Ctrl+D or Ctrl+Z)
//
// Stdin rather than an argument, so the password stays out of shell history.
import { hashPassword } from "./lib/auth.js";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (!password) {
  console.error("read nothing: pipe or type the password on stdin");
  process.exit(1);
}
console.log(await hashPassword(password));
