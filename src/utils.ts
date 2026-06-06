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
