// Test keys only. Made once with ssh-keygen for the web tests; they guard nothing and must never be trusted anywhere.
// Encrypted keys use the passphrase "pw".

/** Test key: ssh-keygen -t ed25519, no passphrase. */
export const ed25519 = {
  key: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBPvK6LwlYNbEv5bUCASlSJC3Gl2YrUCMCvnSChk7DlawAAAJA3QmiRN0Jo
kQAAAAtzc2gtZWQyNTUxOQAAACBPvK6LwlYNbEv5bUCASlSJC3Gl2YrUCMCvnSChk7Dlaw
AAAEChhfThOWromlJuc2CmsKcI5Fhf5dfu4ueZ8/QgKFt5TU+8rovCVg1sS/ltQIBKVIkL
caXZitQIwK+dIKGTsOVrAAAADHRlc3QtZWQyNTUxOQE=
-----END OPENSSH PRIVATE KEY-----
`,
  pub: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE+8rovCVg1sS/ltQIBKVIkLcaXZitQIwK+dIKGTsOVr test-ed25519",
};

/** Test key: ssh-keygen -t ed25519, passphrase pw (aes256-ctr). */
export const ed25519Enc = {
  key: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABAdmhdnAS
2MgjtCitakpC10AAAAIAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIBqql805D5BJBBxn
ycyv3ax68vm6MhawoSGQCrxZ/nUPAAAAoJy3c5s47uY12NGaXmQC8zwlcZ3tnNh7DdZUw8
buep6gSxzO6T0ZFSv22trb7Vd3ji81HmQhziar7R3/8JLXJZaj5cY/blGczT1J6LE3JhhY
JkJhNMUquZsVff1HzGy9UmlktnJxeklfswIQOCXUNuCduHf5SOSOSQoNy/x89t7zr9KTLc
mOdPM0sm8bhK/cQ78HXiJUN4q3+opVIcLowlE=
-----END OPENSSH PRIVATE KEY-----
`,
  pub: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBqql805D5BJBBxnycyv3ax68vm6MhawoSGQCrxZ/nUP test-ed25519-enc",
};

/** Test key: ssh-keygen -t ed25519 -Z aes256-gcm@openssh.com, passphrase pw. */
export const ed25519Gcm = {
  key: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAAFmFlczI1Ni1nY21Ab3BlbnNzaC5jb20AAAAGYmNyeXB0AA
AAGAAAABBQ4PfJgykaCSsXfNtf1T5pAAAAIAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAA
IBhN8SXqwFBfs/FC/3/MgIQfGPOfAfXF+8fDQ+ZmdDkeAAAAoOFdLDBKPmY8jCTXJekJRV
XXTmS5tM9ASCyhsIZrictugmpn/EKAIPAE68W8QdJitV5lBmyaCnLYjjT0jIBCEy+aURcP
w1lduE998M3xOeHvMikuqw53byIQLNod/H7VBDsSYvRjKp1+HURqiM1St3UuJV+SUPEVVf
5KP1wQuI31Y4jRMGYTl7a1CLTssIHh8I3TQWp2teERcwOJVPRRmxtefzjNbH5Ct6mND9Aw
2zQX
-----END OPENSSH PRIVATE KEY-----
`,
  pub: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBhN8SXqwFBfs/FC/3/MgIQfGPOfAfXF+8fDQ+ZmdDke test-ed25519-gcm",
};

/** Test key: ssh-keygen -t ecdsa -b 256, no passphrase. */
export const ecdsa = {
  key: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAaAAAABNlY2RzYS
1zaGEyLW5pc3RwMjU2AAAACG5pc3RwMjU2AAAAQQRvwssYB+nleyy5aGIGwBD8oZ4hd5FJ
UTK7Ktr9JgvlpwdocdtOwEP7IWUOb26R9thIpavad8svyJotsh9M+Uw7AAAAqGo4eUhqOH
lIAAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBG/CyxgH6eV7LLlo
YgbAEPyhniF3kUlRMrsq2v0mC+WnB2hx207AQ/shZQ5vbpH22Eilq9p3yy/Imi2yH0z5TD
sAAAAgBSV2T+fzoymOxL8un8pNpBSTiyHk4v82uZN3YHXCEo4AAAAKdGVzdC1lY2RzYQEC
AwQFBg==
-----END OPENSSH PRIVATE KEY-----
`,
  pub: "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBG/CyxgH6eV7LLloYgbAEPyhniF3kUlRMrsq2v0mC+WnB2hx207AQ/shZQ5vbpH22Eilq9p3yy/Imi2yH0z5TDs= test-ecdsa",
};

/** Test key: ssh-keygen -t ecdsa -b 256, passphrase pw (aes256-ctr). */
export const ecdsaEnc = {
  key: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABBdrWpwDZ
wHxN1xV3hi1m+DAAAAIAAAAAEAAABoAAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlz
dHAyNTYAAABBBISYJ3n6DO+ukjOI4pDNnT9aOWfUxBiHYwB2mknuiba6CqmiDr4rYVbZGq
KxX9rIIG4ur+YYrwNtNsCMARftxDgAAACwQ64Yav32JkeVyMz3O30jVe3R5/nxotLqpvcV
DboiaOht3rRvPTwnxiYwfC6o8YgFASvpQ3MeMH3Nd7N+GtCljnq5n0oUdwhUTRA+i9vuK0
+8dqHhddbxU4ovgxjCJd4RZdmQ2ii4htHXWn5O+kYtOW7miqhO9JmjfC0gSfpDYcYp+MW0
WN2kzjacj58/VgbZnyoTw9ihE7F1ZP6zxZgjaNoty9us7OIQ7d+ZbacA52s=
-----END OPENSSH PRIVATE KEY-----
`,
  pub: "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBISYJ3n6DO+ukjOI4pDNnT9aOWfUxBiHYwB2mknuiba6CqmiDr4rYVbZGqKxX9rIIG4ur+YYrwNtNsCMARftxDg= test-ecdsa-enc",
};

/** Test key: ssh-keygen -t rsa -b 1024, no passphrase. Only used to check that RSA is refused. */
export const rsa = {
  key: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAlwAAAAdzc2gtcn
NhAAAAAwEAAQAAAIEApEdvQiRZeTnLppip/wGZ3NiF0Pr6AoLvjHkU8m6JqUOpVvAVo5/6
7lJHCYv9FreX8cFXbbckcRs+GT+Y7sr9MA026EdbncVLW2n4x7B8jnrpsncMFKXODEXC1h
1l/70CQlS9tAXnewxDO7yx5sKrE13CPkdwv/T55gdMj2LbLy0AAAIA1knj79ZJ4+8AAAAH
c3NoLXJzYQAAAIEApEdvQiRZeTnLppip/wGZ3NiF0Pr6AoLvjHkU8m6JqUOpVvAVo5/67l
JHCYv9FreX8cFXbbckcRs+GT+Y7sr9MA026EdbncVLW2n4x7B8jnrpsncMFKXODEXC1h1l
/70CQlS9tAXnewxDO7yx5sKrE13CPkdwv/T55gdMj2LbLy0AAAADAQABAAAAgBBdsX7UYj
mKgXhiYyUtgqeWxpYQOtH/O2AyO9z/GCXNwNQRbQZ1DKmrdrpDwP3/YlrKWSxr/2xpO2GG
jXTUsi5rZ4OflTSY3CTBQr3DLL4nC0Zmuw6JRvUzTcg2Olq/+x1ecZ/9+2GSEfYzIvkJoB
I+lsJkxrEVTl6N8APpYELdAAAAQDhVr6pxOLaClS4y0i4eNrgrXWvq7EdIn497So/Ca+Ho
fsRbY3343BcXvrqh/vRrrNGPxq2whDt/PO8miQ3ErSYAAABBANg8/jVj0vp2uepkqni+UP
dH3+O3kkvKY/1LymPSyhaUaK14FaLO6EMoI/L+eaK38g9ijBnlM9dDZhDfEbVQ0N8AAABB
AMJ8j1XOsX/fMX/peQLKTdVyKlOYrzHECmAb8QXQzxB/IMIDYF9vUp7vPvRasBxWkio46x
bg6Y2FajBviSanBXMAAAAIdGVzdC1yc2EBAgM=
-----END OPENSSH PRIVATE KEY-----
`,
  pub: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQCkR29CJFl5OcummKn/AZnc2IXQ+voCgu+MeRTybompQ6lW8BWjn/ruUkcJi/0Wt5fxwVdttyRxGz4ZP5juyv0wDTboR1udxUtbafjHsHyOeumydwwUpc4MRcLWHWX/vQJCVL20Bed7DEM7vLHmwqsTXcI+R3C/9PnmB0yPYtsvLQ== test-rsa",
};

