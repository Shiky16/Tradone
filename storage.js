// ── Vault: encrypted, browser-local, device-only data store ────────────────
// Replaces the old app's server-side JSON-file profile (see the root
// server.js/app.js `syncProfileToServer`/`loadProfileAndRestore`) with an
// IndexedDB database encrypted at rest under a passphrase that never leaves
// this device and is never itself persisted anywhere — only a non-extractable
// AES-GCM key derived from it lives in memory, for the current tab session.
//
// Deliberately excludes tradingRules/trades — the new site has no Trading
// tab. Deliberately does NOT touch the ~20 plain-localStorage UI-preference
// keys (currency, language, etc.) — those stay unencrypted local prefs, same
// as before, since the passphrase screen itself needs to render in the
// user's saved language before the vault unlocks.
//
// Exposes a single global `Vault` object (plain script, no bundler — same
// "one big global-scope file" pattern the rest of this app uses).
const Vault = (() => {
  const DB_NAME = 'tradone';
  const DB_VERSION = 1;
  const STORE_META = 'meta';
  const STORE_PROFILE = 'profile';
  const PROFILE_RECORD_ID = 'profile';

  // A fixed plaintext, encrypted under the derived key and stored alongside
  // the salt. Unlocking re-encrypts nothing and decrypts only this — if it
  // comes back wrong (AES-GCM's authentication tag fails), the passphrase
  // was wrong. This lets "wrong passphrase" be a clean `false` return
  // instead of a thrown exception indistinguishable from real corruption.
  const CANARY_PLAINTEXT = 'tradone-vault-canary-v1';

  // OWASP's current (2023+) minimum for PBKDF2-SHA256. Costs ~0.3-0.6s on
  // typical hardware — deliberate: this is the only defense against a
  // stolen device's IndexedDB being brute-forced offline.
  const PBKDF2_ITERATIONS = 600000;

  // Every field ever stored in the `profile` record, with its default value
  // when absent (a fresh vault, or a field added after some vaults already
  // existed). Keep this list in sync with what the app actually reads/writes
  // — it's also the whitelist `saveField` validates against.
  const PROFILE_FIELDS = {
    accounts: [],
    walletAddresses: [],
    manualCryptoPositions: [],
    manualCryptoSales: [],
    expenses: [],
    customExpenseCategories: [],
    hiddenExpenseCategories: [],
    avanzaSnapshot: null,
    paypalSnapshot: null,
    avanzaSession: null,
    paypalSession: null
  };

  // Mirrors the bounds the old server's sanitizeTrades (server.js:76-92)
  // enforced for trade journal entries — expenses are the one remaining
  // field here that can carry attacker-or-bug-controlled size (long notes,
  // many entries), so the same kind of backstop applies, just scoped to
  // what this build actually stores.
  const MAX_EXPENSES = 20000;
  const MAX_EXPENSE_NOTE_LENGTH = 5000;

  // Non-extractable AES-GCM key for the unlocked vault, memory-only —
  // cleared by simply reloading the page. Never written to IndexedDB,
  // localStorage, or sessionStorage under any circumstance.
  let sessionKey = null;

  // Every write to the `profile` record does its own read-modify-write
  // (get the record, change one or more fields, put the whole record back)
  // — IndexedDB has no per-field update. Two such read-modify-writes
  // overlapping (e.g. several fields saved via Promise.all) would race:
  // whichever `put` lands last wins with a stale snapshot of every field
  // it didn't itself touch, silently discarding the other write. Routing
  // every read-modify-write through this chained queue serializes them —
  // each one only starts once the previous one's put has fully landed.
  let writeQueue = Promise.resolve();
  function enqueueWrite(fn) {
    const result = writeQueue.then(fn);
    // Swallow so one failed write doesn't permanently wedge the queue for
    // every write after it — the caller of enqueueWrite still sees the
    // rejection via `result`.
    writeQueue = result.catch(() => {});
    return result;
  }

  function bufToBase64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }

  function base64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_PROFILE)) {
          db.createObjectStore(STORE_PROFILE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGet(db, storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(db, storeName, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function deriveKey(passphrase, saltBuf) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBuf, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable — the raw key material can never be read back out
      ['encrypt', 'decrypt']
    );
  }

  // Every encrypted field gets its own random 12-byte IV (AES-GCM's
  // recommended size) rather than reusing one per vault — reusing an IV
  // with the same key breaks AES-GCM's confidentiality guarantee outright.
  async function encryptValue(key, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return { iv: bufToBase64(iv), data: bufToBase64(ciphertext) };
  }

  async function decryptValue(key, encrypted) {
    const iv = new Uint8Array(base64ToBuf(encrypted.iv));
    const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBuf(encrypted.data));
    return JSON.parse(new TextDecoder().decode(plaintextBuf));
  }

  function requireUnlocked() {
    if (!sessionKey) throw new Error('Vault is locked — call unlockVault() first.');
  }

  async function hasExistingVault() {
    const db = await openDatabase();
    const saltRecord = await idbGet(db, STORE_META, 'salt');
    return !!saltRecord;
  }

  // Bounds an expenses array the same defensive way the old server's
  // sanitizeTrades bounded trades — this is the client's own last line of
  // defense now that there's no server in the write path at all.
  function sanitizeExpenses(rawExpenses) {
    if (!Array.isArray(rawExpenses)) return [];
    return rawExpenses.slice(0, MAX_EXPENSES).map((e) => ({
      id: typeof e?.id === 'string' ? e.id : crypto.randomUUID(),
      type: e?.type === 'earning' ? 'earning' : 'expense',
      category: typeof e?.category === 'string' ? e.category.slice(0, 80) : 'other',
      description: typeof e?.description === 'string' ? e.description.slice(0, 200) : '',
      amount: Number.isFinite(e?.amount) ? e.amount : 0,
      date: typeof e?.date === 'string' ? e.date.slice(0, 10) : '',
      accountId: typeof e?.accountId === 'string' ? e.accountId : null,
      notes: typeof e?.notes === 'string' ? e.notes.slice(0, MAX_EXPENSE_NOTE_LENGTH) : undefined,
      createdAt: typeof e?.createdAt === 'string' ? e.createdAt : new Date().toISOString()
    }));
  }

  function sanitizeField(name, value) {
    if (name === 'expenses') return sanitizeExpenses(value);
    if (Array.isArray(PROFILE_FIELDS[name])) return Array.isArray(value) ? value : [];
    return value;
  }

  // Creates a brand-new, empty vault. Throws if one already exists for this
  // origin — callers must check hasExistingVault() first (the boot flow
  // branches on this instead of silently overwriting).
  async function createVault(passphrase) {
    if (!passphrase || passphrase.length < 8) {
      throw new Error('Passphrase must be at least 8 characters.');
    }
    const db = await openDatabase();
    if (await idbGet(db, STORE_META, 'salt')) {
      throw new Error('A vault already exists — unlock it instead of creating a new one.');
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, salt);
    const canary = await encryptValue(key, CANARY_PLAINTEXT);

    await idbPut(db, STORE_META, { key: 'salt', value: bufToBase64(salt) });
    await idbPut(db, STORE_META, { key: 'canary', value: canary });
    await idbPut(db, STORE_META, { key: 'schemaVersion', value: 1 });

    const emptyProfile = { id: PROFILE_RECORD_ID };
    for (const [field, defaultValue] of Object.entries(PROFILE_FIELDS)) {
      emptyProfile[field] = await encryptValue(key, defaultValue);
    }
    await idbPut(db, STORE_PROFILE, emptyProfile);

    sessionKey = key;
    return true;
  }

  // Attempts to unlock an existing vault. Returns false (not a throw) on a
  // wrong passphrase — see CANARY_PLAINTEXT above for why that distinction
  // matters. Any other failure (no vault at all, IndexedDB unavailable)
  // still throws, since those aren't "try again" situations.
  async function unlockVault(passphrase) {
    const db = await openDatabase();
    const saltRecord = await idbGet(db, STORE_META, 'salt');
    if (!saltRecord) throw new Error('No vault exists yet — call createVault() first.');
    const canaryRecord = await idbGet(db, STORE_META, 'canary');

    const salt = base64ToBuf(saltRecord.value);
    const key = await deriveKey(passphrase, salt);

    try {
      const decoded = await decryptValue(key, canaryRecord.value);
      if (decoded !== CANARY_PLAINTEXT) return false;
    } catch {
      // AES-GCM's authentication tag check throws on any wrong key —
      // this is the expected shape of "wrong passphrase", not an error.
      return false;
    }

    sessionKey = key;
    return true;
  }

  function lockVault() {
    sessionKey = null;
  }

  function isUnlocked() {
    return !!sessionKey;
  }

  // Decrypts every field in the profile record and returns them as one
  // plain object, e.g. { accounts: [...], expenses: [...], ... } — the
  // same shape the old app's loadProfileAndRestore populated its client-side
  // variables from.
  async function loadAllFields() {
    requireUnlocked();
    const db = await openDatabase();
    const record = await idbGet(db, STORE_PROFILE, PROFILE_RECORD_ID);
    if (!record) throw new Error('Vault has no profile record — it may be corrupted.');

    const result = {};
    for (const field of Object.keys(PROFILE_FIELDS)) {
      result[field] = record[field] ? await decryptValue(sessionKey, record[field]) : PROFILE_FIELDS[field];
    }
    return result;
  }

  // Re-encrypts and writes back just one field — every other field's
  // ciphertext is untouched, so saving one edited expense never requires
  // touching e.g. avanzaSnapshot or accounts. Queued (see enqueueWrite)
  // so it can never race another saveField/saveFields call.
  function saveField(name, value) {
    return saveFields({ [name]: value });
  }

  // Re-encrypts and writes back several fields in one read-modify-write —
  // the atomic version saveField itself is built on. Always use this (not
  // several parallel saveField calls) when writing more than one field at
  // once — see the enqueueWrite comment above for exactly what goes wrong
  // otherwise.
  function saveFields(fields) {
    requireUnlocked();
    for (const name of Object.keys(fields)) {
      if (!(name in PROFILE_FIELDS)) throw new Error(`Unknown vault field "${name}".`);
    }
    return enqueueWrite(async () => {
      const db = await openDatabase();
      const record = (await idbGet(db, STORE_PROFILE, PROFILE_RECORD_ID)) || { id: PROFILE_RECORD_ID };
      for (const [name, value] of Object.entries(fields)) {
        record[name] = await encryptValue(sessionKey, sanitizeField(name, value));
      }
      await idbPut(db, STORE_PROFILE, record);
    });
  }

  // Decrypts everything and returns a plain JSON string — the basis for
  // both the one-time import-from-old-app flow (writes each field via
  // saveField after createVault) and the "download an unencrypted backup"
  // feature (see the plan: recommended given a lost passphrase means lost
  // data, with no server-side recovery possible by design).
  async function exportProfileJson() {
    const fields = await loadAllFields();
    return JSON.stringify(fields, null, 2);
  }

  // Writes every recognized field from a plain object (e.g. parsed from an
  // export, or from the old app's GET /api/account/profile response) into
  // the just-created vault. Unknown fields (like the old app's
  // tradingRules/trades) are silently ignored — this build has no Trading
  // tab to receive them.
  async function importProfileFields(fields) {
    requireUnlocked();
    const toSave = {};
    for (const name of Object.keys(PROFILE_FIELDS)) {
      if (name in fields) toSave[name] = fields[name];
    }
    await saveFields(toSave);
  }

  return {
    hasExistingVault,
    createVault,
    unlockVault,
    lockVault,
    isUnlocked,
    loadAllFields,
    saveField,
    saveFields,
    exportProfileJson,
    importProfileFields,
    PROFILE_FIELDS
  };
})();
