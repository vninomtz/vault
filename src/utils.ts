const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length;

export function ulid(): string {
  const now = Date.now();
  const timeChars = Array.from<string>({ length: 10 });
  let t = now;
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = ENCODING[t % ENCODING_LEN] ?? "0";
    t = Math.floor(t / ENCODING_LEN);
  }
  const randomPart = Array.from(
    { length: 16 },
    () => ENCODING[Math.floor(Math.random() * ENCODING_LEN)] ?? "0",
  ).join("");
  return timeChars.join("") + randomPart;
}

export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
