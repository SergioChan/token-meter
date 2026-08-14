import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const IDENTITY_VERSION = 1;

// Excludes 0/O/1/I so meter IDs survive being read aloud or retyped.
export const METER_ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const METER_ID_GROUPS = 3;
const METER_ID_GROUP_LENGTH = 4;

export function defaultIdentityDir() {
  return join(homedir(), "Library", "Application Support", "Token Meter", "State", "Identity");
}

export function deriveMeterId(publicKeyDer) {
  const digest = createHash("sha256").update(publicKeyDer).digest();
  const groups = [];
  let index = 0;
  for (let group = 0; group < METER_ID_GROUPS; group += 1) {
    let chunk = "";
    for (let char = 0; char < METER_ID_GROUP_LENGTH; char += 1) {
      chunk += METER_ID_ALPHABET[digest[index] % METER_ID_ALPHABET.length];
      index += 1;
    }
    groups.push(chunk);
  }
  return `TM-${groups.join("-")}`;
}

export function isMeterId(value) {
  return typeof value === "string" && /^TM(-[2-9A-HJ-NP-Z]{4}){3}$/.test(value);
}

export function createIdentity(nowMs = Date.now()) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  return {
    version: IDENTITY_VERSION,
    meterId: deriveMeterId(publicKeyDer),
    publicKey: publicKeyDer.toString("base64"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    createdAtMs: nowMs,
    handle: null,
    handleClaimed: false,
    sharing: { enabled: false },
  };
}

export function loadOrCreateIdentity(dirPath = defaultIdentityDir(), nowMs = Date.now()) {
  const filePath = join(dirPath, "identity.json");
  if (existsSync(filePath)) {
    const identity = JSON.parse(readFileSync(filePath, "utf8"));
    if (identity.version !== IDENTITY_VERSION || !isMeterId(identity.meterId)) {
      throw new Error(`unsupported identity file: ${filePath}`);
    }
    return identity;
  }
  const identity = createIdentity(nowMs);
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return identity;
}

function saveIdentity(identity, dirPath) {
  writeFileSync(join(dirPath, "identity.json"), `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o600,
  });
  return identity;
}

export function setSharingEnabled(enabled, dirPath = defaultIdentityDir()) {
  const identity = loadOrCreateIdentity(dirPath);
  identity.sharing = { ...identity.sharing, enabled: Boolean(enabled) };
  return saveIdentity(identity, dirPath);
}

// Handles are local aliases until a registry backend exists to claim them;
// `claimed` stays false so the UI can distinguish verified handles later.
export function isValidHandle(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,29}$/.test(value);
}

export function setHandle(handle, dirPath = defaultIdentityDir()) {
  if (handle != null && !isValidHandle(handle)) {
    throw new Error(
      "handle must be 2-30 chars: lowercase letters, digits, hyphens; starting with a letter or digit",
    );
  }
  const identity = loadOrCreateIdentity(dirPath);
  identity.handle = handle ?? null;
  identity.handleClaimed = false;
  return saveIdentity(identity, dirPath);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value != null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signPayload(identity, payload) {
  const signature = sign(null, Buffer.from(canonicalize(payload)), identity.privateKeyPem);
  return { payload, signature: signature.toString("base64") };
}

export function verifySignedPayload(report) {
  const { payload, signature } = report ?? {};
  if (payload == null || typeof signature !== "string") return false;
  const publicKeyDer = Buffer.from(payload.publicKey ?? "", "base64");
  if (deriveMeterId(publicKeyDer) !== payload.meterId) return false;
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicKeyDer, type: "spki", format: "der" });
  } catch {
    return false;
  }
  return verify(null, Buffer.from(canonicalize(payload)), publicKey, Buffer.from(signature, "base64"));
}

export function markHandleClaimed(dirPath = defaultIdentityDir()) {
  const identity = loadOrCreateIdentity(dirPath);
  identity.handleClaimed = true;
  return saveIdentity(identity, dirPath);
}

export function buildSignedUsageReport(identity, usage) {
  const payload = {
    version: IDENTITY_VERSION,
    meterId: identity.meterId,
    publicKey: identity.publicKey,
    periodStartMs: usage.periodStartMs,
    periodEndMs: usage.periodEndMs,
    totalTokens: usage.totalTokens,
    sessionCount: usage.sessionCount ?? null,
    peakTokensPerMinute: usage.peakTokensPerMinute ?? null,
  };
  const signature = sign(null, Buffer.from(canonicalize(payload)), identity.privateKeyPem);
  return { payload, signature: signature.toString("base64") };
}

export function verifySignedUsageReport(report) {
  const { payload, signature } = report;
  if (payload == null || typeof signature !== "string") return false;
  const publicKeyDer = Buffer.from(payload.publicKey ?? "", "base64");
  if (deriveMeterId(publicKeyDer) !== payload.meterId) return false;
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicKeyDer, type: "spki", format: "der" });
  } catch {
    return false;
  }
  return verify(null, Buffer.from(canonicalize(payload)), publicKey, Buffer.from(signature, "base64"));
}
