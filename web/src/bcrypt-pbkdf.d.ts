/** The OpenBSD bcrypt_pbkdf, as the npm package `bcrypt-pbkdf` gives it (it has no types of its own). */
declare module "bcrypt-pbkdf" {
  const bcrypt: {
    /** Fills `key` with `keylen` bytes. Returns 0, or -1 for bad arguments. */
    pbkdf(pass: Uint8Array, passlen: number, salt: Uint8Array, saltlen: number, key: Uint8Array, keylen: number, rounds: number): number;
  };
  export default bcrypt;
}
