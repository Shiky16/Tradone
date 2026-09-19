// ── Tradone relay ────────────────────────────────────────────────────────
// Stateless multi-tenant relay for the web/ build — proxies external APIs
// only (Avanza, PayPal, crypto chains, news). Holds no per-user database:
// every visitor's actual portfolio data lives in their own browser's
// encrypted IndexedDB vault (see storage.js), never here. Where an external
// login flow needs session continuity across 2+ requests (Avanza, BankID,
// PayPal), the session material is handed back to the client and resent on
// each subsequent call instead of being kept in a server-side global — see
// the plan doc for why (a single shared `let avanzaClient` etc. is exactly
// what made the original single-user server.js unsafe to host for more
// than one person at once).
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Avanza = require('avanza-api').default;
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
// Chrome's Private Network Access checks block a page's fetch to a loopback
// server unless the preflight response explicitly allows it — without this,
// requests from a non-localhost origin fail with a generic "Failed to
// fetch" before any route handler even runs. Must run before cors(), since
// cors() ends OPTIONS preflight requests itself and never calls next() for
// them.
app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const AVANZA_BASE = 'https://www.avanza.se';

// ── PayPal (Business account balance) ───────────────────────────────────────
// PayPal has no personal-login equivalent of Avanza's BankID — only a
// Business account's own REST API app (Client ID + Secret, generated at
// developer.paypal.com) can read that account's balance at all, via OAuth2
// client-credentials + the Balances reporting endpoint.
const PAYPAL_API_BASE = {
  live: 'https://api-m.paypal.com',
  sandbox: 'https://api-m.sandbox.paypal.com'
};

// Username/password + TOTP auth. Avanza retired the BankID endpoint this
// used to hit (POST /_api/authentication/sessions/bankid now 405s — the
// avanza-api package hasn't been updated since), so this is the only login
// path the underlying library still has working. Requires the Avanza account
// to have TOTP (authenticator app) two-factor enabled, not BankID/SMS.
//
// Stateless: the resulting session is handed back to the caller instead of
// kept here, so it's the caller's job to store it (the web app keeps it in
// its own encrypted vault, see storage.js's avanzaSession field) and resend
// it — see the X-Avanza-Session header read by requireAvanzaSession below —
// on every subsequent Avanza call.
app.post('/api/auth', async (req, res) => {
  const { username, password, totp } = req.body;
  if (!username || !password || !totp) {
    return res.status(400).json({ error: 'Username, password, and 2FA code are required.' });
  }

  try {
    const client = new Avanza();
    await client.authenticate({ username, password, totp });
    res.json({ success: true, session: { securityToken: client.session.securityToken, authenticationSession: client.session.authenticationSession, cookies: client.cookies || null } });
  } catch (err) {
    const msg = typeof err === 'string' ? err : (err.message || 'Authentication failed.');
    console.error('Auth error:', msg);
    res.status(401).json({ error: msg });
  }
});

// ── BankID QR login ──────────────────────────────────────────────────────
// The avanza-api package's BankID code hits a personnummer-push endpoint
// that Avanza retired. Their actual current web login uses a QR-code BankID
// flow instead (confirmed by watching the real login page's network
// traffic), so this reimplements just that flow directly against Avanza's
// API rather than going through the outdated package for this part.
//
// One cookie (AZABANKIDTRANSID) ties every call in a login attempt together
// — Avanza hands it back as Set-Cookie from the /start call, and it has to
// be echoed on /restart and /collect. Unlike the original single-user
// server, many of these can be in flight at once here (one per visitor
// mid-scan), so each gets its own flowId rather than sharing one module
// global — see bankidFlows below.
const bankidFlows = new Map(); // flowId -> { cookie, expiresAt }
const BANKID_FLOW_TTL_MS = 5 * 60 * 1000;

// Sweeps flows nobody ever finished polling (closed tab mid-scan, etc.) so
// they don't accumulate in memory on a long-running, many-visitor relay.
setInterval(() => {
  const now = Date.now();
  for (const [flowId, flow] of bankidFlows) {
    if (now > flow.expiresAt) bankidFlows.delete(flowId);
  }
}, 60_000).unref();

app.post('/api/auth/bankid/start', async (_req, res) => {
  try {
    const upstream = await fetch(`${AVANZA_BASE}/_api/authentication/v2/sessions/bankid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'QR_START', returnScheme: 'NULL' })
    });
    const setCookie = upstream.headers.get('set-cookie');
    const match = setCookie && /AZABANKIDTRANSID=[^;]+/.exec(setCookie);
    if (!match) throw new Error('Avanza did not start a BankID session (no transaction cookie returned).');

    const data = await upstream.json();
    const flowId = crypto.randomUUID();
    bankidFlows.set(flowId, { cookie: match[0], expiresAt: Date.now() + BANKID_FLOW_TTL_MS });

    const qrDataUrl = await QRCode.toDataURL(data.qrToken);
    res.json({ flowId, qr: qrDataUrl, expires: data.expires });
  } catch (err) {
    const msg = typeof err === 'string' ? err : (err.message || 'Failed to start BankID login.');
    console.error('BankID start error:', msg);
    res.status(502).json({ error: msg });
  }
});

// Polled every couple of seconds while the QR code is on screen. Each call
// both refreshes the QR (Avanza rotates it roughly every second) and checks
// whether the phone has approved yet, so the frontend only needs one loop.
app.post('/api/auth/bankid/poll', async (req, res) => {
  const { flowId } = req.body || {};
  const flow = flowId && bankidFlows.get(flowId);
  if (!flow) {
    return res.status(400).json({ error: 'No BankID login in progress — scan again from the start.' });
  }
  const bankidTransCookie = flow.cookie;

  try {
    const restartRes = await fetch(`${AVANZA_BASE}/_api/authentication/v2/sessions/bankid/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: bankidTransCookie },
      body: '{}'
    });
    const restartData = await restartRes.json();
    const qrDataUrl = await QRCode.toDataURL(restartData.qrToken);

    const collectRes = await fetch(`${AVANZA_BASE}/_api/authentication/v2/sessions/bankid/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: bankidTransCookie },
      body: '{}'
    });
    const collectData = await collectRes.json();

    if (collectData.state === 'OUTSTANDING_TRANSACTION' || collectData.state === 'PENDING') {
      return res.json({ done: false, qr: qrDataUrl, hint: collectData.hint });
    }

    // Anything other than the two "still waiting" states is logged in full —
    // the exact shape of a real approval/failure hasn't been observed live
    // (this was built from network traffic that never got a real BankID
    // scan/approval), so this is the seam most likely to need a follow-up
    // fix once someone actually approves a login on their phone.
    console.log('BankID collect reached a terminal state:', JSON.stringify(collectData));

    if (collectData.state === 'COMPLETE') {
      let session;
      const login = collectData.logins?.[0];
      if (login?.loginPath) {
        const customerRes = await fetch(`${AVANZA_BASE}${login.loginPath}`, {
          headers: { Cookie: bankidTransCookie }
        });
        const securityToken = customerRes.headers.get('x-securitytoken');
        const customerData = await customerRes.json();
        if (!securityToken || !customerData.authenticationSession) {
          throw new Error(`Unexpected response finishing BankID login: ${JSON.stringify(customerData)}`);
        }
        // The X-SecurityToken/X-AuthenticationSession headers alone got a bare
        // 401 "Access denied" from Avanza's current /_api endpoints — a real
        // browser would also carry whatever session cookie this response sets
        // (Avanza consistently sets AZAPERSISTENCE elsewhere), so capture and
        // replay it too in case the new endpoints require both.
        const cookies = (customerRes.headers.getSetCookie?.() || [])
          .map((c) => c.split(';')[0])
          .join('; ');
        session = { securityToken, authenticationSession: customerData.authenticationSession, cookies };
      } else if (collectData.authenticationSession && collectData.securityToken) {
        session = { securityToken: collectData.securityToken, authenticationSession: collectData.authenticationSession, cookies: null };
      } else {
        throw new Error(`BankID reported COMPLETE but the response had no usable session: ${JSON.stringify(collectData)}`);
      }
      bankidFlows.delete(flowId);
      return res.json({ done: true, session });
    }

    bankidFlows.delete(flowId);
    return res.status(401).json({ error: collectData.hint || collectData.state || 'BankID login failed or was cancelled.' });
  } catch (err) {
    bankidFlows.delete(flowId);
    const msg = typeof err === 'string' ? err : (err.message || 'BankID polling failed.');
    console.error('BankID poll error:', msg);
    res.status(502).json({ error: msg });
  }
});

// Client-credentials grant — this authenticates the *app* (Client ID +
// Secret), not a person, which is exactly why it can only ever return the
// balance of the Business account that app belongs to.
async function getPaypalAccessToken(clientId, clientSecret, env) {
  const base = PAYPAL_API_BASE[env] || PAYPAL_API_BASE.live;
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || 'PayPal rejected those credentials.');
  return { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 0) * 1000 };
}

async function fetchPaypalBalances(env, accessToken) {
  const base = PAYPAL_API_BASE[env] || PAYPAL_API_BASE.live;
  const res = await fetch(`${base}/v1/reporting/balances`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.message ||
      'Failed to fetch PayPal balance (the app may be missing the Transaction Search / Balances permission).'
    );
  }
  return data;
}

// Refreshes the access token first if it's already expired (or about to,
// inside a minute) so a page sitting open for a while doesn't hit a 401
// mid-request — same reasoning as any other short-lived OAuth token cache.
// Pure function: takes and returns a session object instead of mutating
// shared state, since the caller (not this relay) is what persists it now.
async function ensurePaypalToken(session) {
  if (Date.now() < session.expiresAt - 60_000) return session;
  const { accessToken, expiresAt } = await getPaypalAccessToken(session.clientId, session.clientSecret, session.env);
  return { ...session, accessToken, expiresAt };
}

app.post('/api/paypal/connect', async (req, res) => {
  // A trailing space/newline from a copy-paste is silently wrong rather than
  // an obvious error — PayPal just returns the same generic "Client
  // Authentication failed" as a genuinely bad secret — so this trims
  // defensively here too, not just client-side.
  const clientId = (req.body?.clientId || '').trim();
  const clientSecret = (req.body?.clientSecret || '').trim();
  const env = req.body?.env;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'Client ID and secret are required.' });
  }

  const environment = env === 'sandbox' ? 'sandbox' : 'live';
  // Diagnostic only — lengths/prefixes, never the actual secret — so a
  // truncated-paste or wrong-field-swap is visible in the server console
  // without the real credential ever having to be shared with anyone.
  console.log(
    `PayPal connect attempt: env=${environment} clientId(len=${clientId.length}, starts "${clientId.slice(0, 4)}") ` +
    `clientSecret(len=${clientSecret.length}, starts "${clientSecret.slice(0, 4)}")`
  );
  try {
    const { accessToken, expiresAt } = await getPaypalAccessToken(clientId, clientSecret, environment);
    const data = await fetchPaypalBalances(environment, accessToken);
    res.json({
      success: true,
      balances: data.balances || [],
      accountId: data.account_id || null,
      session: { clientId, clientSecret, env: environment, accessToken, expiresAt }
    });
  } catch (err) {
    const msg = typeof err === 'string' ? err : (err.message || 'Failed to connect to PayPal.');
    console.error('PayPal connect error:', msg);
    res.status(401).json({ error: msg });
  }
});

// POST, not GET — the session (including the refreshable credentials) has
// to travel in a body now that there's nothing held server-side for it to
// reference by an implicit "current connection."
app.post('/api/paypal/balance', async (req, res) => {
  const session = req.body?.session;
  if (!session?.clientId || !session?.clientSecret || !session?.accessToken) {
    return res.status(400).json({ error: 'Missing PayPal session.' });
  }
  try {
    const refreshed = await ensurePaypalToken(session);
    const data = await fetchPaypalBalances(refreshed.env, refreshed.accessToken);
    res.json({ success: true, balances: data.balances || [], accountId: data.account_id || null, session: refreshed });
  } catch (err) {
    const msg = typeof err === 'string' ? err : (err.message || 'Failed to fetch PayPal balance.');
    console.error('PayPal balance error:', msg);
    res.status(502).json({ error: msg });
  }
});

// avanza-api's getAccountsSummary()/getPositionsByInstrumentType()/authFetch
// still hit Avanza's old /_mobile/... endpoints, which now return the
// website's HTML shell instead of JSON (retired the same way the BankID push
// endpoint was — see the auth comment above). These helpers call the
// endpoints/shapes confirmed by inspecting a real logged-in browser session's
// network traffic: auth is just the Cookie jar from login (csid, cstoken,
// AZACSRF, ...) plus an X-SecurityToken header equal to the AZACSRF cookie
// value — which is exactly what the BankID loginPath response already
// returns as `x-securitytoken`, so no extra login step was needed.
// session is now a parameter, not a closure over a module-global client —
// see the file-top comment for why (a shared global would let two
// concurrent visitors' Avanza requests use each other's session).
async function avanzaRequest(method, path, body, session) {
  const res = await fetch(`${AVANZA_BASE}${path}`, {
    method,
    headers: {
      'X-SecurityToken': session.securityToken,
      ...(session.cookies ? { Cookie: session.cookies } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || !contentType.includes('application/json')) {
    const bodyText = await res.text().catch(() => '(could not read body)');
    console.error(`avanza ${method} ${path} failed — status ${res.status}, content-type ${contentType}\nbody: ${bodyText.slice(0, 1000)}`);
    throw new Error(`Avanza returned an unexpected response for ${path} (status ${res.status}) — the endpoint may have changed again.`);
  }
  return res.json();
}
const avanzaGet = (path, session) => avanzaRequest('GET', path, undefined, session);
const avanzaPost = (path, body, session) => avanzaRequest('POST', path, body, session);

// Reads the caller's Avanza session from the X-Avanza-Session header (a
// base64'd JSON object — {securityToken, authenticationSession, cookies} —
// the exact shape /api/auth and the BankID poll's COMPLETE response return).
// Returns null (not a throw) on anything missing/malformed so callers can
// turn that into a plain 401 instead of a 500.
function parseAvanzaSessionHeader(req) {
  const raw = req.headers['x-avanza-session'];
  if (!raw) return null;
  try {
    const session = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
    if (!session?.securityToken || !session?.authenticationSession) return null;
    return session;
  } catch {
    return null;
  }
}

// Accounts list has no balance/gain data — that comes from a separate
// per-account-ids POST. urlParameterId is kept on the merged result because
// getAccountPositions (below) needs it, not the plain account id.
async function getAccountsOverview(session) {
  const accountsList = await avanzaGet('/_api/account-overview/accounts/list', session);
  if (!accountsList.length) return { accounts: [] };

  const totals = await avanzaPost(
    '/_api/account-performance/overview/total-values',
    accountsList.map((acc) => acc.id),
    session
  );
  const totalsById = new Map((totals.accounts || []).map((a) => [a.info?.id, a]));

  return {
    accounts: accountsList.map((acc) => {
      const totalData = totalsById.get(acc.id);
      return {
        accountId: acc.id,
        name: acc.name,
        accountType: acc.accountType,
        urlParameterId: acc.urlParameterId,
        totalBalance: totalData?.totalValue?.totalValue?.value ?? null,
        // Confirmed via a live response: this endpoint has no portfolio
        // "development"/gain figure at all, and no interest rate either —
        // accruedInterest (interest earned but not yet paid out) is the only
        // P&L-shaped number it exposes, used as a cash-only account's Open
        // P&L fallback below (see /api/stats/:accountId).
        accruedInterest: totalData?.totalValue?.accruedInterest?.value ?? null
      };
    })
  };
}

// Positions are fetched one account at a time, keyed by that account's
// urlParameterId (not its plain id). Value/averageAcquiredPrice come back
// SEK-normalized regardless of the instrument's trading currency, so
// currentPrice is derived the same way (value/volume) to stay consistent —
// mixing in the instrument's native-currency quote here would silently
// mislabel a SEK amount as USD/EUR elsewhere in this file.
async function getAccountPositions(urlParameterId, session) {
  const data = await avanzaGet(`/_api/position-data/positions/${urlParameterId}`, session);
  const rawPositions = [...(data.withOrderbook || []), ...(data.withoutOrderbook || [])];

  const positions = rawPositions.map((p) => {
    const volume = p.volume?.value ?? 0;
    const currentValue = p.value?.value ?? 0;
    const acquiredValue = p.acquiredValue?.value ?? null;
    const profit = acquiredValue != null ? currentValue - acquiredValue : null;
    const profitPercent = acquiredValue ? (profit / acquiredValue) * 100 : null;

    return {
      accountId: p.account?.id,
      orderbookId: p.instrument?.orderbook?.id ?? null,
      orderbookName: p.instrument?.name,
      volume,
      value: currentValue,
      currentPrice: volume > 0 ? currentValue / volume : null,
      averageAcquisitionPrice: p.averageAcquiredPrice?.value ?? null,
      profit,
      profitPercent,
      currency: 'SEK'
    };
  });

  return { instrumentPositions: [{ instrumentType: 'ALL', positions }] };
}

app.get('/api/overview', async (req, res) => {
  const session = parseAvanzaSessionHeader(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const summary = await getAccountsOverview(session);
    res.json(summary);
  } catch (err) {
    const msg = typeof err === 'string' ? err : err.message;
    res.status(500).json({ error: msg });
  }
});

app.get('/api/stats/:accountId', async (req, res) => {
  const session = parseAvanzaSessionHeader(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });

  const { accountId } = req.params;

  const fromDate = new Date();
  fromDate.setFullYear(fromDate.getFullYear() - 12);
  const fromDateStr = fromDate.toISOString().slice(0, 10);
  const toDateStr = new Date().toISOString().slice(0, 10);

  try {
    const summary = await getAccountsOverview(session);
    const account = (summary.accounts || []).find(a => a.accountId === accountId);
    if (!account) return res.status(404).json({ error: 'Account not found.' });

    const positionsData = await getAccountPositions(account.urlParameterId, session);

    // Flatten all positions, keeping only those belonging to this account
    const allPositions = [];
    for (const group of (positionsData.instrumentPositions || [])) {
      for (const pos of (group.positions || [])) {
        if (!pos.accountId || pos.accountId === accountId) {
          allPositions.push({ ...pos, instrumentType: group.instrumentType });
        }
      }
    }

    // Fetch transactions to get first-purchase date per instrument, and to
    // derive realized P&L for any SELL transactions. This endpoint
    // (/_api/transactions/list, replacing the retired
    // /_mobile/account/transactions/:accountId) isn't scoped to one account
    // by the request, so results are filtered by tx.account.id below instead.
    // The exact transaction-type string Avanza uses isn't confirmed live, so
    // this matches loosely (same tolerant approach as before) — same for the
    // numeric fields, which may come back as a plain number or wrapped as
    // { value } like positions' acquiredValue does (see getAccountPositions).
    const firstBuyDate = {};
    const closedPositions = [];
    try {
      const qs = new URLSearchParams({ maxElements: '1000', from: fromDateStr, to: toDateStr });
      const txData = await avanzaGet(`/_api/transactions/list?${qs}`, session);
      const txNum = (v) => {
        if (typeof v === 'number') return v;
        if (v && typeof v.value === 'number') return v.value;
        return null;
      };

      const accountTx = (txData.transactions || [])
        .filter(tx => !tx.account?.id || tx.account.id === accountId)
        .map(tx => {
          const type = (tx.type || tx.description || '').toUpperCase();
          return {
            isBuy: type.includes('BUY') || type.includes('BOUGHT') || type.includes('KÖP'),
            isSell: type.includes('SELL') || type.includes('SOLD') || type.includes('SÅLD') || type.includes('SALE'),
            orderbookId: tx.orderbook?.id ?? null,
            name: tx.orderbook?.name ?? null,
            date: tx.tradeDate || tx.date || null,
            volume: Math.abs(txNum(tx.volume) ?? 0),
            amount: Math.abs(txNum(tx.sum) ?? txNum(tx.amount) ?? 0)
          };
        })
        .filter(tx => tx.orderbookId && tx.date && (tx.isBuy || tx.isSell))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      for (const tx of accountTx) {
        if (!tx.isBuy) continue;
        if (!firstBuyDate[tx.orderbookId] || tx.date < firstBuyDate[tx.orderbookId]) {
          firstBuyDate[tx.orderbookId] = tx.date;
        }
      }

      // Walk chronologically per instrument with a running average-cost
      // basis, so each SELL's realized P&L is (proceeds − avg cost of the
      // shares sold) — the same average-cost method Avanza uses for open
      // positions' averageAcquisitionPrice, just carried past a full exit.
      // Note: a position first bought outside the fromDate/toDate window
      // (12 years back) would understate its cost basis here — same
      // limitation the pre-existing first-purchase-date lookup above has.
      const costBasis = {};
      for (const tx of accountTx) {
        if (!tx.volume || !tx.amount) continue;
        const basis = costBasis[tx.orderbookId] || (costBasis[tx.orderbookId] = { volume: 0, cost: 0 });
        if (tx.isBuy) {
          basis.volume += tx.volume;
          basis.cost += tx.amount;
        } else if (tx.isSell) {
          const avgCost = basis.volume > 0 ? basis.cost / basis.volume : null;
          const soldVolume = Math.min(tx.volume, basis.volume);
          const costOfSold = avgCost != null ? avgCost * soldVolume : null;
          const realizedPnl = costOfSold != null ? tx.amount - costOfSold : null;
          closedPositions.push({
            name: tx.name || 'Unknown',
            orderbookId: tx.orderbookId,
            soldDate: tx.date,
            volume: tx.volume,
            avgBuyPrice: avgCost,
            sellPrice: tx.volume > 0 ? tx.amount / tx.volume : null,
            proceeds: tx.amount,
            realizedPnl,
            realizedPnlPercent: costOfSold ? (realizedPnl / costOfSold) * 100 : null,
            currency: 'SEK'
          });
          basis.volume = Math.max(0, basis.volume - soldVolume);
          basis.cost = Math.max(0, basis.cost - (costOfSold ?? 0));
        }
      }
      closedPositions.sort((a, b) => (a.soldDate < b.soldDate ? 1 : -1));
    } catch (txErr) {
      // First-purchase dates and realized P&L will show as N/A — not fatal
      const msg = typeof txErr === 'string' ? txErr : txErr.message;
      console.warn('Could not fetch transactions:', msg);
    }

    // Avanza positions already include averageAcquisitionPrice, profit, profitPercent
    const positions = allPositions.map(pos => {
      const volume = Number(pos.volume) || 0;
      const currentValue = Number(pos.value) || 0;
      const currentPrice = pos.currentPrice ?? (volume > 0 ? currentValue / volume : 0);
      const avgBuyPrice = pos.averageAcquisitionPrice ?? null;
      const gainAbsolute = pos.profit ?? (avgBuyPrice != null ? currentValue - avgBuyPrice * volume : null);
      const gainPercent = pos.profitPercent ?? (avgBuyPrice != null && avgBuyPrice > 0
        ? ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100
        : null);

      return {
        name: pos.orderbookName || pos.name || 'Unknown',
        orderbookId: pos.orderbookId,
        volume,
        currentPrice,
        currentValue,
        avgBuyPrice,
        firstPurchaseDate: firstBuyDate[pos.orderbookId] || null,
        gainAbsolute,
        gainPercent,
        currency: pos.currency || 'SEK'
      };
    });

    // account.totalBalance (from account-performance/overview/total-values)
    // is the account's true total value, cash included — positions above
    // only cover securities, so a cash-only account (e.g. a Sparkonto
    // savings account) would otherwise always compute to 0 here and get
    // filtered out by the dust threshold on the client even once it holds
    // money. Math.max rather than adding the two together, since any cash
    // sitting alongside securities in the same account is already part of
    // totalBalance — summing would double-count it.
    const positionsValue = positions.reduce((s, p) => s + (p.currentValue || 0), 0);
    const totalCurrentValue = Math.max(positionsValue, account.totalBalance ?? 0);
    const knownPositions = positions.filter(p => p.avgBuyPrice != null);
    const totalCost = knownPositions.reduce((s, p) => s + p.avgBuyPrice * p.volume, 0);
    const positionsGain = positions.reduce((s, p) => s + (p.gainAbsolute || 0), 0);
    const totalRealizedPnl = closedPositions.reduce((s, p) => s + (p.realizedPnl || 0), 0);

    // No known cost basis to compute a gain from ourselves (a pure-cash
    // savings account has no securities at all; some other account might
    // hold positions Avanza didn't give us an acquisition price for) — fall
    // back to accrued (not yet paid out) interest as Open P&L instead of
    // showing N/A. There's no percentage to go with it: Avanza's API has no
    // interest-rate field anywhere, and accrued interest alone doesn't say
    // how long it accrued over, so a % here would just be a guess.
    const hasKnownCostBasis = totalCost > 0;
    const totalGain = hasKnownCostBasis ? positionsGain : (account.accruedInterest ?? null);
    const totalGainPercent = hasKnownCostBasis ? (positionsGain / totalCost) * 100 : null;

    res.json({
      account: {
        id: account.accountId,
        name: account.name,
        type: account.accountType,
        totalBalance: account.totalBalance
      },
      positions,
      closedPositions,
      summary: {
        totalCurrentValue,
        totalCost,
        totalGain,
        totalGainPercent,
        totalRealizedPnl
      }
    });
  } catch (err) {
    const msg = typeof err === 'string' ? err : err.message;
    console.error('Stats error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── Crypto wallet (Ethereum) ────────────────────────────────────────────────

const ETHPLORER = 'https://api.ethplorer.io';
const COINGECKO = 'https://api.coingecko.com/api/v3';
const ETHERSCAN = 'https://api.etherscan.io/v2/api';
// Free key: https://etherscan.io/apis — Ethplorer's freekey only sees the last 30 days
// of transfer history, so Etherscan is used instead to find true first-received dates.
//
// Unlike the original single-user server, these have no literal fallback
// key baked in: that was fine on a machine only its owner ever ran, but a
// publicly-hosted relay would otherwise let any caller ride on one shared
// key/quota for free. Fail fast at boot instead of silently degrading.
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
if (!COINGECKO_API_KEY || !ETHERSCAN_API_KEY) {
  console.error('Missing required env vars: COINGECKO_API_KEY and ETHERSCAN_API_KEY must both be set.');
  process.exit(1);
}
const DUST_THRESHOLD_USD = 0.5;

// Applied to the CoinGecko/Etherscan-backed routes below (see marketDataLimiter
// usage) — a shared relay's own keys/quotas are worth protecting from any one
// caller hammering them, unlike the original local-only server where the
// only possible caller was its own owner.
const marketDataLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Pulls a coin id out of a CoinGecko coin-page URL, e.g.
// "coingecko.com/en/coins/bitcoin" → "bitcoin". Unlike a TradingView/stock
// ticker, this needs no fuzzy matching — the page slug in the URL *is* the
// exact id CoinGecko's own API uses, so it's an exact lookup, not a guess.
function parseCoinGeckoId(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'coingecko.com') return null;

  const parts = parsed.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('coins');
  return idx >= 0 && parts[idx + 1] ? decodeURIComponent(parts[idx + 1]).toLowerCase() : null;
}

// Resolves a manually-entered CoinGecko coin-page link to a live USD price,
// so a manually-added coin's value can be computed (amount × price) instead
// of typed in by hand. Crypto only — CoinGecko has no stock/forex/index data.
app.get('/api/manual-price', marketDataLimiter, async (req, res) => {
  const coinId = parseCoinGeckoId(req.query.url || '');
  if (!coinId) {
    return res.status(400).json({ error: "Couldn't find a coin in that link — use a CoinGecko coin page URL, e.g. coingecko.com/en/coins/bitcoin." });
  }

  try {
    const coinRes = await fetch(`${COINGECKO}/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false&x_cg_demo_api_key=${COINGECKO_API_KEY}`);
    const coinData = await coinRes.json();
    const price = coinData.market_data?.current_price?.usd ?? null;
    if (!coinData.id || price == null) {
      return res.status(404).json({ error: `No CoinGecko coin found for "${coinId}".` });
    }

    res.json({ symbol: (coinData.symbol || coinId).toUpperCase(), coinId: coinData.id, name: coinData.name || coinId, price });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to resolve price.' });
  }
});

// Re-fetches the current USD price for a coin id already resolved once via
// /api/manual-price — used to refresh a manually-added position's stored
// value (amount × price) without the user re-pasting its CoinGecko link.
app.get('/api/coin-price/:coinId', marketDataLimiter, async (req, res) => {
  try {
    const prices = await getCoingeckoPrices([req.params.coinId]);
    const price = prices[req.params.coinId]?.usd ?? null;
    if (price == null) {
      return res.status(404).json({ error: `No current price found for "${req.params.coinId}".` });
    }
    res.json({ coinId: req.params.coinId, price });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch price.' });
  }
});

// USD price of a coin id on a given date — used to fill in a manually-added
// position's cost basis when the user picks a "first received" date, instead
// of asking them to know and type in a historical price by hand. Unlike
// getHistoricalPrice() below (used internally by the on-chain wallet
// endpoints, where "no price" is already a handled, silent case), this one
// surfaces CoinGecko's actual error — rate limit, unknown coin id, no data
// recorded for that date, etc. — instead of collapsing every failure into
// the same generic "not found", since this is the one place that error
// message actually reaches a user.
async function getHistoricalPriceDetailed(coinId, isoDate) {
  const [y, m, d] = isoDate.split('-');
  const res = await fetch(`${COINGECKO}/coins/${coinId}/history?date=${d}-${m}-${y}&localization=false&x_cg_demo_api_key=${COINGECKO_API_KEY}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.status?.error_message || data?.error || `CoinGecko returned HTTP ${res.status}.`);
  }
  const price = data.market_data?.current_price?.usd ?? null;
  if (price == null) {
    throw new Error(`CoinGecko has no USD price on record for "${coinId}" on ${isoDate}.`);
  }
  return price;
}

app.get('/api/coin-history/:coinId', marketDataLimiter, async (req, res) => {
  const date = req.query.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return res.status(400).json({ error: 'date query param is required, as YYYY-MM-DD.' });
  }
  try {
    const price = await getHistoricalPriceDetailed(req.params.coinId, date);
    res.json({ coinId: req.params.coinId, date, price });
  } catch (err) {
    res.status(404).json({ error: err.message || `No historical price found for "${req.params.coinId}" on ${date}.` });
  }
});

async function fetchEtherscan(params) {
  const qs = new URLSearchParams({ chainid: '1', apikey: ETHERSCAN_API_KEY, ...params });
  const res = await fetch(`${ETHERSCAN}?${qs}`);
  const data = await res.json();
  return Array.isArray(data.result) ? data.result : [];
}

// Finds the earliest date each token (and ETH) arrived in the wallet, using
// full transaction history — not limited to a recent window like Ethplorer's freekey.
async function getFirstReceivedDates(address) {
  const lowerAddr = address.toLowerCase();
  const firstReceived = {};
  let ethFirstReceived = null;

  const baseParams = { module: 'account', address, startblock: '0', endblock: '999999999', sort: 'asc', offset: '10000', page: '1' };

  const [normalTxs, internalTxs, tokenTxs] = await Promise.all([
    fetchEtherscan({ ...baseParams, action: 'txlist' }),
    fetchEtherscan({ ...baseParams, action: 'txlistinternal' }),
    fetchEtherscan({ ...baseParams, action: 'tokentx' })
  ]);

  for (const tx of [...normalTxs, ...internalTxs]) {
    if (tx.to?.toLowerCase() !== lowerAddr) continue;
    if (tx.isError === '1' || Number(tx.value) <= 0) continue;
    const date = new Date(Number(tx.timeStamp) * 1000).toISOString().slice(0, 10);
    if (!ethFirstReceived || date < ethFirstReceived) ethFirstReceived = date;
  }

  for (const tx of tokenTxs) {
    if (tx.to?.toLowerCase() !== lowerAddr) continue;
    const ca = tx.contractAddress?.toLowerCase();
    if (!ca) continue;
    const date = new Date(Number(tx.timeStamp) * 1000).toISOString().slice(0, 10);
    if (!firstReceived[ca] || date < firstReceived[ca]) firstReceived[ca] = date;
  }

  return { firstReceived, ethFirstReceived };
}

async function getHistoricalPrice(coinId, isoDate) {
  if (!coinId || !isoDate) return null;
  const [y, m, d] = isoDate.split('-');
  try {
    const res = await fetch(`${COINGECKO}/coins/${coinId}/history?date=${d}-${m}-${y}&localization=false&x_cg_demo_api_key=${COINGECKO_API_KEY}`);
    const data = await res.json();
    return data.market_data?.current_price?.usd ?? null;
  } catch {
    return null;
  }
}

// Kiln's "On-Chain Staked Ethereum" (ocsETH) — a staking receipt contract that
// Ethplorer's token scanner doesn't pick up, so it's queried directly on-chain.
const ETH_RPC = 'https://ethereum-rpc.publicnode.com';
const KILN_OCSETH_CONTRACT = '0x2401c39d7ba9e283668a53fcc7b8f5fd9e716fdf';
const BALANCE_OF_UNDERLYING_SELECTOR = '0x3af9e669'; // balanceOfUnderlying(address)

async function getKilnStakedEth(address) {
  const data = BALANCE_OF_UNDERLYING_SELECTOR + address.slice(2).toLowerCase().padStart(64, '0');
  const res = await fetch(ETH_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: KILN_OCSETH_CONTRACT, data }, 'latest'] })
  });
  const { result, error } = await res.json();
  if (error) throw new Error(error.message);
  return Number(BigInt(result)) / 1e18;
}

app.get('/api/wallet/:address', marketDataLimiter, async (req, res) => {
  const { address } = req.params;

  if (!/^0x[0-9a-fA-F]{40}$/i.test(address)) {
    return res.status(400).json({ error: 'Invalid Ethereum address.' });
  }

  try {
    // Three calls: wallet snapshot (Ethplorer), full transfer history (Etherscan),
    // and on-chain staked ETH balance (Kiln ocsETH — not seen by Ethplorer)
    const [infoData, { firstReceived, ethFirstReceived }, stakedEthBalance] = await Promise.all([
      fetch(`${ETHPLORER}/getAddressInfo/${address}?apiKey=freekey`).then(r => r.json()),
      getFirstReceivedDates(address).catch(() => ({ firstReceived: {}, ethFirstReceived: null })),
      getKilnStakedEth(address).catch(() => 0)
    ]);

    const positions = [];

    // ETH position
    const ethBalance   = infoData.ETH?.balance ?? 0;
    const ethPrice     = infoData.ETH?.price?.rate ?? 0;

    if (ethBalance * ethPrice >= DUST_THRESHOLD_USD) {
      const histPrice = await getHistoricalPrice('ethereum', ethFirstReceived);
      positions.push({
        symbol: 'ETH',
        name: 'Ethereum',
        contractAddress: 'native',
        coinId: 'ethereum',
        balance: ethBalance,
        currentPrice: ethPrice,
        currentValue: ethBalance * ethPrice,
        firstReceivedDate: ethFirstReceived,
        priceAtFirstReceived: histPrice,
        gainPercent: histPrice ? ((ethPrice - histPrice) / histPrice) * 100 : null,
        gainAbsolute: histPrice ? (ethPrice - histPrice) * ethBalance : null
      });
    }

    // Staked ETH (Kiln ocsETH) — no first-received date or cost basis, since
    // it's a rebasing receipt rather than a discrete transfer-in of ETH. Still
    // carries a coinId so the client can offer a manual "Set date" for anyone
    // who wants to track a cost basis for it anyway.
    if (stakedEthBalance * ethPrice >= DUST_THRESHOLD_USD) {
      positions.push({
        symbol: 'ETH',
        name: 'Staked ETH (Kiln)',
        contractAddress: KILN_OCSETH_CONTRACT,
        coinId: 'ethereum',
        balance: stakedEthBalance,
        currentPrice: ethPrice,
        currentValue: stakedEthBalance * ethPrice,
        firstReceivedDate: null,
        priceAtFirstReceived: null,
        gainPercent: null,
        gainAbsolute: null
      });
    }

    // ERC-20 token positions — Ethplorer's `balance` field is raw (un-adjusted for
    // decimals), so it has to be scaled down before it means anything.
    const tokens = (infoData.tokens || [])
      .map(t => {
        const decimals = Number(t.tokenInfo?.decimals);
        const divisor = Number.isFinite(decimals) ? Math.pow(10, decimals) : 1;
        return { ...t, balance: Number(t.rawBalance) / divisor };
      })
      .filter(t => t.balance > 0)
      // Already represented via the dedicated Kiln staked-ETH position above.
      .filter(t => t.tokenInfo?.address?.toLowerCase() !== KILN_OCSETH_CONTRACT)
      .sort((a, b) => {
        const aVal = a.tokenInfo.price ? a.balance * a.tokenInfo.price.rate : 0;
        const bVal = b.tokenInfo.price ? b.balance * b.tokenInfo.price.rate : 0;
        return bVal - aVal;
      });

    // Fetch historical prices for top 5 tokens that have a known price
    const topPricedTokens = tokens.filter(t => t.tokenInfo.price).slice(0, 5);

    for (const token of tokens) {
      const ca           = token.tokenInfo.address.toLowerCase();
      const currentPrice = token.tokenInfo.price ? token.tokenInfo.price.rate : null;
      const balance      = token.balance;
      const currentValue = currentPrice ? balance * currentPrice : null;
      const firstDate    = firstReceived[ca] ?? null;

      // Skip dust — but keep tokens with no known price, since we can't
      // tell whether they're worthless or just unlisted on Ethplorer.
      if (currentValue != null && currentValue < DUST_THRESHOLD_USD) continue;

      let histPrice = null;
      let coinId = null;
      if (currentPrice && firstDate && topPricedTokens.includes(token)) {
        try {
          await sleep(350);
          const coinRes  = await fetch(`${COINGECKO}/coins/ethereum/contract/${ca}?x_cg_demo_api_key=${COINGECKO_API_KEY}`);
          const coinData = await coinRes.json();
          if (coinData.id) {
            coinId = coinData.id;
            await sleep(350);
            histPrice = await getHistoricalPrice(coinData.id, firstDate);
          }
        } catch { /* historical price unavailable */ }
      }

      positions.push({
        symbol: token.tokenInfo.symbol || '?',
        name: token.tokenInfo.name || 'Unknown token',
        contractAddress: ca,
        coinId,
        balance,
        currentPrice,
        currentValue,
        firstReceivedDate: firstDate,
        priceAtFirstReceived: histPrice,
        gainPercent: histPrice && currentPrice ? ((currentPrice - histPrice) / histPrice) * 100 : null,
        gainAbsolute: histPrice && currentPrice ? (currentPrice - histPrice) * balance : null
      });
    }

    res.json({
      address,
      positions,
      totalCurrentValue: positions.reduce((s, p) => s + (p.currentValue ?? 0), 0)
    });

  } catch (err) {
    console.error('Wallet error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Solana (liquid balance + SPL tokens + staked positions) ──────────────────

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const STAKE_PROGRAM_ID = 'Stake11111111111111111111111111111111111111';
const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// u64::MAX — the sentinel Solana uses for "not deactivating"
const NO_DEACTIVATION_EPOCH = '18446744073709551615';

async function solanaRpc(method, params) {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// A stake account's authorized staker/withdrawer are usually both set to the
// owning wallet, but query both offsets and de-dupe in case they differ.
async function getStakeAccounts(address) {
  const filtersFor = (offset) => [{ dataSize: 200 }, { memcmp: { offset, bytes: address } }];
  const [byStaker, byWithdrawer] = await Promise.all([
    solanaRpc('getProgramAccounts', [STAKE_PROGRAM_ID, { encoding: 'jsonParsed', filters: filtersFor(12) }]),
    solanaRpc('getProgramAccounts', [STAKE_PROGRAM_ID, { encoding: 'jsonParsed', filters: filtersFor(44) }])
  ]);

  const byPubkey = new Map();
  for (const acc of [...byStaker, ...byWithdrawer]) byPubkey.set(acc.pubkey, acc);
  return [...byPubkey.values()];
}

async function getSolanaTokenInfo(mint) {
  try {
    const res = await fetch(`${COINGECKO}/coins/solana/contract/${mint}?x_cg_demo_api_key=${COINGECKO_API_KEY}`);
    const data = await res.json();
    if (data.error) return { price: null, symbol: null, name: null, coinId: null };
    return {
      price: data.market_data?.current_price?.usd ?? null,
      symbol: data.symbol ? data.symbol.toUpperCase() : null,
      name: data.name ?? null,
      coinId: data.id ?? null
    };
  } catch {
    return { price: null, symbol: null, name: null, coinId: null };
  }
}

// Approximates "first received" as the date of the earliest transaction
// involving this address at all — Solana accounts are rent-exempt-funded on
// creation, so for a wallet or token account the first signature is usually
// also its first inbound transfer. Paginates backward in pages of 1000 (the
// RPC max) up to a bounded number of pages so a very old, very active address
// can't hang the request indefinitely.
async function getSolanaFirstSignatureDate(address) {
  try {
    let before;
    let oldest = null;
    for (let page = 0; page < 10; page++) {
      const params = before ? [address, { limit: 1000, before }] : [address, { limit: 1000 }];
      const sigs = await solanaRpc('getSignaturesForAddress', params);
      if (!sigs.length) break;
      oldest = sigs[sigs.length - 1];
      if (sigs.length < 1000) break;
      before = oldest.signature;
      await sleep(350);
    }
    return oldest?.blockTime ? new Date(oldest.blockTime * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

app.get('/api/solana/:address', marketDataLimiter, async (req, res) => {
  const { address } = req.params;

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid Solana address.' });
  }

  try {
    const [stakeAccounts, balanceResult, tokenAccountsResult, priceData] = await Promise.all([
      getStakeAccounts(address),
      solanaRpc('getBalance', [address]),
      solanaRpc('getTokenAccountsByOwner', [address, { programId: SPL_TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed' }]),
      fetch(`${COINGECKO}/simple/price?ids=solana&vs_currencies=usd&x_cg_demo_api_key=${COINGECKO_API_KEY}`).then(r => r.json())
    ]);

    const solPrice = priceData.solana?.usd ?? 0;
    const positions = [];

    // Liquid (unstaked) SOL sitting directly in the wallet
    const solBalance = (balanceResult?.value ?? 0) / 1e9;
    const liquidValue = solBalance * solPrice;
    if (liquidValue >= DUST_THRESHOLD_USD) {
      const firstDate = await getSolanaFirstSignatureDate(address);
      const histPrice = firstDate ? await getHistoricalPrice('solana', firstDate) : null;
      positions.push({
        type: 'liquid',
        symbol: 'SOL',
        name: 'Solana',
        mint: null,
        coinId: 'solana',
        balance: solBalance,
        currentPrice: solPrice,
        currentValue: liquidValue,
        firstReceivedDate: firstDate,
        priceAtFirstReceived: histPrice,
        gainPercent: histPrice ? ((solPrice - histPrice) / histPrice) * 100 : null,
        gainAbsolute: histPrice ? (solPrice - histPrice) * solBalance : null
      });
    }

    // SPL tokens — RPC gives us balances but not symbol/price, so look each
    // up on CoinGecko (skip zero-balance accounts, common for dust/empty ATAs).
    const tokenAccounts = (tokenAccountsResult?.value || [])
      .filter(acc => Number(acc.account.data.parsed.info.tokenAmount.uiAmount) > 0);

    for (const acc of tokenAccounts) {
      const info = acc.account.data.parsed.info;
      const balance = Number(info.tokenAmount.uiAmount);
      const { price, symbol, name, coinId } = await getSolanaTokenInfo(info.mint);
      const currentValue = price != null ? balance * price : null;
      if (currentValue != null && currentValue < DUST_THRESHOLD_USD) continue;

      let firstDate = null;
      let histPrice = null;
      if (price != null && coinId) {
        firstDate = await getSolanaFirstSignatureDate(acc.pubkey);
        if (firstDate) {
          await sleep(350);
          histPrice = await getHistoricalPrice(coinId, firstDate);
        }
      }

      positions.push({
        type: 'liquid',
        symbol: symbol || `${info.mint.slice(0, 4)}…${info.mint.slice(-4)}`,
        name: name || 'Unknown SPL token',
        mint: info.mint,
        coinId,
        balance,
        currentPrice: price,
        currentValue,
        firstReceivedDate: firstDate,
        priceAtFirstReceived: histPrice,
        gainPercent: histPrice && price ? ((price - histPrice) / histPrice) * 100 : null,
        gainAbsolute: histPrice && price ? (price - histPrice) * balance : null
      });
      await sleep(350);
    }

    // Staked SOL (stake-program accounts delegated to a validator). Cost basis
    // here is the stake account's own funding date, which for SOL delegated
    // some time after it was first acquired reflects "when it was staked" more
    // than "when it was bought" — same caveat as the Kiln staked-ETH position.
    for (const acc of stakeAccounts) {
      const info = acc.account?.data?.parsed?.info;
      const delegation = info?.stake?.delegation;
      if (!delegation) continue; // undelegated stake account (e.g. fully withdrawn)

      const lamports = Number(delegation.stake) + Number(info.meta?.rentExemptReserve || 0);
      const balance = lamports / 1e9;
      const currentValue = balance * solPrice;
      if (currentValue < DUST_THRESHOLD_USD) continue;

      const firstDate = await getSolanaFirstSignatureDate(acc.pubkey);
      const histPrice = firstDate ? await getHistoricalPrice('solana', firstDate) : null;

      positions.push({
        type: 'staked',
        symbol: 'SOL',
        name: 'Solana (staked)',
        stakeAccount: acc.pubkey,
        validator: delegation.voter,
        coinId: 'solana',
        balance,
        currentPrice: solPrice,
        currentValue,
        deactivating: delegation.deactivationEpoch !== NO_DEACTIVATION_EPOCH,
        firstReceivedDate: firstDate,
        priceAtFirstReceived: histPrice,
        gainPercent: histPrice ? ((solPrice - histPrice) / histPrice) * 100 : null,
        gainAbsolute: histPrice ? (solPrice - histPrice) * balance : null
      });
    }

    res.json({
      address,
      positions,
      totalCurrentValue: positions.reduce((s, p) => s + (p.currentValue ?? 0), 0)
    });
  } catch (err) {
    console.error('Solana error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Other chains (BNB Smart Chain, Optimism, NEAR, XRP, Litecoin, Stellar, TON) ──
// BSC and Optimism only report specific known tokens rather than scanning the
// whole wallet — Etherscan's free-tier V2 API no longer covers either chain,
// and BscScan's standalone API is deprecated, so full auto-discovery would
// require a paid key. Reads go straight to public RPC endpoints instead,
// same technique as the Kiln staked-ETH lookup above.

async function evmRpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const { result, error } = await res.json();
  if (error) throw new Error(error.message);
  return result;
}

const ERC20_BALANCE_OF_SELECTOR = '0x70a08231'; // balanceOf(address)

async function erc20Balance(rpcUrl, tokenContract, address, decimals = 18) {
  const data = ERC20_BALANCE_OF_SELECTOR + address.slice(2).toLowerCase().padStart(64, '0');
  const result = await evmRpcCall(rpcUrl, 'eth_call', [{ to: tokenContract, data }, 'latest']);
  return Number(BigInt(result)) / Math.pow(10, decimals);
}

async function evmNativeBalance(rpcUrl, address) {
  const result = await evmRpcCall(rpcUrl, 'eth_getBalance', [address, 'latest']);
  return Number(BigInt(result)) / 1e18;
}

async function getCoingeckoPrices(ids) {
  const res = await fetch(`${COINGECKO}/simple/price?ids=${ids.join(',')}&vs_currencies=usd&x_cg_demo_api_key=${COINGECKO_API_KEY}`);
  return res.json();
}

// Builds position objects and drops dust — but keeps positions with an
// unknown price, same rationale as the ERC-20 scan above.
function toPositions(entries) {
  return entries
    .map(p => ({ ...p, currentValue: p.currentPrice != null ? p.balance * p.currentPrice : null }))
    .filter(p => p.currentValue == null || p.currentValue >= DUST_THRESHOLD_USD);
}

const BSC_RPC = 'https://bsc-dataseed.binance.org';
const TWT_CONTRACT = '0x4b0f1812e5df2a09796481ff14017e6005508003';
const BSC_PEG_LTC_CONTRACT = '0x4338665cbb7b2485a8855a139b75d5e34ab0db94';

async function getBscPositions(address) {
  const [bnbBalance, twtBalance, ltcBalance, prices] = await Promise.all([
    evmNativeBalance(BSC_RPC, address),
    erc20Balance(BSC_RPC, TWT_CONTRACT, address),
    erc20Balance(BSC_RPC, BSC_PEG_LTC_CONTRACT, address),
    getCoingeckoPrices(['binancecoin', 'trust-wallet-token', 'binance-peg-litecoin'])
  ]);

  return toPositions([
    { symbol: 'BNB', name: 'BNB', coinId: 'binancecoin', balance: bnbBalance, currentPrice: prices.binancecoin?.usd ?? null },
    { symbol: 'TWT', name: 'Trust Wallet Token', coinId: 'trust-wallet-token', balance: twtBalance, currentPrice: prices['trust-wallet-token']?.usd ?? null },
    { symbol: 'LTC', name: 'Binance-Peg Litecoin', coinId: 'binance-peg-litecoin', balance: ltcBalance, currentPrice: prices['binance-peg-litecoin']?.usd ?? null }
  ]);
}

const OPTIMISM_RPC = 'https://mainnet.optimism.io';
const OP_TOKEN_CONTRACT = '0x4200000000000000000000000000000000000042';

async function getOptimismPositions(address) {
  const [opBalance, prices] = await Promise.all([
    erc20Balance(OPTIMISM_RPC, OP_TOKEN_CONTRACT, address),
    getCoingeckoPrices(['optimism'])
  ]);

  return toPositions([
    { symbol: 'OP', name: 'Optimism', coinId: 'optimism', balance: opBalance, currentPrice: prices.optimism?.usd ?? null }
  ]);
}

const NEAR_RPC = 'https://rpc.mainnet.near.org';

async function getNearPositions(accountId) {
  const res = await fetch(NEAR_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId }
    })
  });
  const { result, error } = await res.json();
  if (error) throw new Error(error.data || error.message || 'NEAR account not found.');

  const balance = Number(BigInt(result.amount)) / 1e24;
  const prices = await getCoingeckoPrices(['near']);

  return toPositions([
    { symbol: 'NEAR', name: 'NEAR Protocol', coinId: 'near', balance, currentPrice: prices.near?.usd ?? null }
  ]);
}

const XRP_RPC = 'https://xrplcluster.com';

// Builds the four cost-basis fields shared by every "simple chain" position
// below, given a current price and a resolved first-received date.
async function costBasisFields(coinId, firstDate, currentPrice, balance) {
  const histPrice = firstDate ? await getHistoricalPrice(coinId, firstDate) : null;
  return {
    coinId,
    firstReceivedDate: firstDate,
    priceAtFirstReceived: histPrice,
    gainPercent: histPrice && currentPrice ? ((currentPrice - histPrice) / histPrice) * 100 : null,
    gainAbsolute: histPrice && currentPrice ? (currentPrice - histPrice) * balance : null
  };
}

// account_tx with forward:true starts from the ledger genesis, so the first
// result is this account's earliest transaction. Ripple Epoch (the `date`
// field) starts 2000-01-01, which is 946684800s after the Unix epoch.
async function getXrpFirstReceivedDate(address) {
  const RIPPLE_EPOCH_OFFSET = 946684800;
  try {
    const res = await fetch(XRP_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'account_tx',
        params: [{ account: address, ledger_index_min: -1, ledger_index_max: -1, forward: true, limit: 1 }]
      })
    });
    const { result } = await res.json();
    const entry = result?.transactions?.[0];
    const date = entry?.tx?.date ?? entry?.tx_json?.date;
    return date != null ? new Date((date + RIPPLE_EPOCH_OFFSET) * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

async function getXrpPositions(address) {
  const res = await fetch(XRP_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'account_info', params: [{ account: address, ledger_index: 'validated' }] })
  });
  const { result } = await res.json();
  if (result.error) throw new Error(result.error_message || result.error || 'XRP account not found.');

  const balance = Number(result.account_data.Balance) / 1e6;
  const [prices, firstDate] = await Promise.all([
    getCoingeckoPrices(['ripple']),
    getXrpFirstReceivedDate(address)
  ]);
  const currentPrice = prices.ripple?.usd ?? null;

  return toPositions([
    { symbol: 'XRP', name: 'XRP', balance, currentPrice, ...(await costBasisFields('ripple', firstDate, currentPrice, balance)) }
  ]);
}

// BlockCypher caps a single call at 2000 refs, so a very old/active address
// may not surface its true first transaction — best effort, same tradeoff as
// the Ethplorer-vs-Etherscan choice made for Ethereum above.
async function getLitecoinFirstReceivedDate(address) {
  try {
    const res = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}?limit=2000`);
    const data = await res.json();
    const refs = [...(data.txrefs || []), ...(data.unconfirmed_txrefs || [])];
    const received = refs.filter(r => r.tx_input_n === -1 && r.confirmed);
    if (!received.length) return null;
    return received.reduce((min, r) => (r.confirmed < min ? r.confirmed : min), received[0].confirmed).slice(0, 10);
  } catch {
    return null;
  }
}

async function getLitecoinPositions(address) {
  const [res, firstDate] = await Promise.all([
    fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance`),
    getLitecoinFirstReceivedDate(address)
  ]);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const balance = (data.balance ?? 0) / 1e8;
  const prices = await getCoingeckoPrices(['litecoin']);
  const currentPrice = prices.litecoin?.usd ?? null;

  return toPositions([
    { symbol: 'LTC', name: 'Litecoin', balance, currentPrice, ...(await costBasisFields('litecoin', firstDate, currentPrice, balance)) }
  ]);
}

// Horizon's oldest transaction is approximated as "first received" — for most
// personal wallets that's the account-creation/funding transaction anyway.
async function getStellarFirstReceivedDate(address) {
  try {
    const res = await fetch(`https://horizon.stellar.org/accounts/${address}/transactions?order=asc&limit=1`);
    const data = await res.json();
    const tx = data._embedded?.records?.[0];
    return tx ? tx.created_at.slice(0, 10) : null;
  } catch {
    return null;
  }
}

async function getStellarPositions(address) {
  const res = await fetch(`https://horizon.stellar.org/accounts/${address}`);
  const data = await res.json();
  if (data.status && data.status !== 200) throw new Error(data.detail || 'Stellar account not found (or not yet funded).');

  const native = (data.balances || []).find(b => b.asset_type === 'native');
  const balance = native ? Number(native.balance) : 0;
  const [prices, firstDate] = await Promise.all([
    getCoingeckoPrices(['stellar']),
    getStellarFirstReceivedDate(address)
  ]);
  const currentPrice = prices.stellar?.usd ?? null;

  return toPositions([
    { symbol: 'XLM', name: 'Stellar Lumens', balance, currentPrice, ...(await costBasisFields('stellar', firstDate, currentPrice, balance)) }
  ]);
}

// Toncenter's getTransactions pages newest-first; walking backward via each
// page's oldest (lt, hash) cursor reaches the true first transaction, bounded
// to 15 pages (1500 txs) so a very active address can't hang the request.
async function getTonFirstReceivedDate(address) {
  try {
    let lt, hash;
    let oldestTime = null;
    for (let page = 0; page < 15; page++) {
      const params = new URLSearchParams({ address, limit: '100' });
      if (lt) params.set('lt', lt);
      if (hash) params.set('hash', hash);
      const res = await fetch(`https://toncenter.com/api/v2/getTransactions?${params}`);
      const data = await res.json();
      const txs = data.result || [];
      if (!txs.length) break;
      for (const tx of txs) {
        if (oldestTime == null || tx.utime < oldestTime) oldestTime = tx.utime;
      }
      if (txs.length < 100) break;
      const last = txs[txs.length - 1];
      lt = last.transaction_id.lt;
      hash = last.transaction_id.hash;
      await sleep(1000);
    }
    return oldestTime ? new Date(oldestTime * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

async function getTonPositions(address) {
  const res = await fetch(`https://toncenter.com/api/v2/getAddressBalance?address=${address}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Failed to fetch TON account.');

  const balance = Number(data.result) / 1e9;
  const [prices, firstDate] = await Promise.all([
    getCoingeckoPrices(['the-open-network']),
    getTonFirstReceivedDate(address)
  ]);
  const currentPrice = prices['the-open-network']?.usd ?? null;

  return toPositions([
    { symbol: 'TON', name: 'Toncoin', balance, currentPrice, ...(await costBasisFields('the-open-network', firstDate, currentPrice, balance)) }
  ]);
}

const CHAIN_ADDRESS_PATTERNS = {
  bsc: /^0x[0-9a-fA-F]{40}$/,
  optimism: /^0x[0-9a-fA-F]{40}$/,
  near: /^[a-z0-9_.-]{2,64}$/,
  xrp: /^r[1-9A-HJ-NP-Za-km-z]{25,34}$/,
  litecoin: /^(L|M|ltc1)[0-9a-zA-Z]{25,60}$/,
  stellar: /^G[A-Z2-7]{55}$/,
  ton: /^[A-Za-z0-9_-]{48}$/
};

const CHAIN_HANDLERS = {
  bsc: getBscPositions,
  optimism: getOptimismPositions,
  near: getNearPositions,
  xrp: getXrpPositions,
  litecoin: getLitecoinPositions,
  stellar: getStellarPositions,
  ton: getTonPositions
};

app.get('/api/chain/:chain/:address', marketDataLimiter, async (req, res) => {
  const { chain, address } = req.params;
  const pattern = CHAIN_ADDRESS_PATTERNS[chain];
  const handler = CHAIN_HANDLERS[chain];

  if (!pattern || !handler) {
    return res.status(400).json({ error: `Unsupported chain: ${chain}` });
  }
  if (!pattern.test(address)) {
    return res.status(400).json({ error: `Invalid ${chain} address.` });
  }

  try {
    const positions = await handler(address);
    res.json({
      address,
      chain,
      positions,
      totalCurrentValue: positions.reduce((s, p) => s + (p.currentValue ?? 0), 0)
    });
  } catch (err) {
    console.error(`${chain} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Portfolio news ───────────────────────────────────────────────────────────
// Both feeds go through Finnhub, on the one free key the user already has to
// get for stock news — one signup instead of two. Originally crypto news came
// from CryptoCompare (per-coin categorized), but CryptoCompare, CryptoPanic,
// and CoinGecko's news endpoint all retired their free tiers within weeks of
// each other in 2026, leaving no free per-coin crypto news source. Finnhub's
// own /news?category=crypto (used below) is free but not filterable by coin —
// it's general crypto-market news rather than "news about what you hold" the
// way the stock half is. The key is never stored server-side (same treatment
// as the PayPal Client ID/Secret above): the client holds it in localStorage
// and passes it with each request.

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000;

// Company-name → ticker-symbol lookups don't change, so a resolved (or
// definitively unresolved) name is cached for the life of the process instead
// of spending a Finnhub /search call on it every single refresh.
const finnhubSymbolCache = new Map();
// A /search call that threw (e.g. a rate-limited HTML response instead of
// JSON — seen live under bursty refreshing) isn't cached in finnhubSymbolCache
// itself, since it's not a real "no match" answer and retrying later could
// well succeed — but retrying on every single refresh just re-triggers the
// same rate limit. This is a short cooldown per name instead.
const finnhubSymbolFailureCache = new Map();
const SYMBOL_FAILURE_COOLDOWN_MS = 3 * 60 * 1000;
// Once a symbol is confirmed to 403 on /company-news (Finnhub's free tier
// only allows it for a subset of, apparently, US-primary-listed symbols —
// confirmed live for foreign listings like ENB.TO/NOVO B.CO/2330.TW), that's
// a standing access restriction, not a transient error, so it's cached for
// the life of the process to stop re-asking a question we already know the
// answer to on every refresh.
const finnhubUnauthorizedSymbols = new Set();
// Keyed by the exact symbol-set requested — a personal dashboard only ever
// has one holder's worth of symbols in flight, so a single-slot cache per
// endpoint is enough to avoid re-hitting the upstream API on every page load.
let cryptoNewsCache = { key: '', data: null, fetchedAt: 0 };
let stockNewsCache = { key: '', data: null, fetchedAt: 0 };
let marketNewsCache = { key: '', data: null, fetchedAt: 0 };

function newsCacheGet(cache, key) {
  if (cache.key === key && Date.now() - cache.fetchedAt < NEWS_CACHE_TTL_MS) return cache.data;
  return null;
}

// Yahoo Finance's own per-ticker RSS feed — no API key, and unlike Google
// News' RSS search (tried and rejected: its feed is licensed "solely for
// ... a personal feed reader," which doesn't fit embedding results in this
// app), Yahoo's feed carries a plain "all rights reserved" copyright with
// no comparable restriction. It also directly closes the gap Finnhub's
// free tier can't: confirmed live, it returns real per-symbol articles for
// both NVO (Novo Nordisk, a foreign listing Finnhub's /company-news 403s
// on) and SOL-USD (Solana, which Finnhub has no per-coin endpoint for at
// all). Ticker format is the same symbol resolveFinnhubSymbol already
// resolves for stocks; crypto uses Yahoo's own "{SYMBOL}-USD" convention.
function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

function extractXmlTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeXmlEntities(match[1]) : '';
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Yahoo Finance';
  }
}

// A hash, not Buffer.from(url).toString('base64url').slice(0, N) — Yahoo's
// article URLs mostly share a long common prefix (e.g. everything under
// finance.yahoo.com/markets/...), so a truncated *encoding* of the raw URL
// truncates to the same characters for many different articles. Confirmed
// live: several distinct articles collided onto the same id that way. A
// hash's output is uniformly distributed, so a short slice of it doesn't
// have that problem.
function newsIdFromUrl(prefix, url) {
  return `${prefix}-${crypto.createHash('sha1').update(url).digest('base64url').slice(0, 16)}`;
}

// Hand-rolled (regex, not a real XML parser) rather than adding a
// dependency for it — Yahoo's feed shape is small and stable in practice,
// and every value still goes through decodeXmlEntities above regardless of
// whether it arrives CDATA-wrapped or entity-escaped.
async function fetchYahooFinanceRss(symbol, logPrefix) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    console.error(`${logPrefix} ${symbol}: fetch threw: ${err.name} — ${err.message}`);
    return [];
  }
  if (!res.ok) {
    console.error(`${logPrefix} ${symbol}: HTTP ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const blocks = xml.split('<item>').slice(1);
  const items = blocks
    .map((block) => {
      const body = block.split('</item>')[0];
      const title = extractXmlTag(body, 'title');
      // Yahoo appends its own "?.tsrc=rss" tracking param to every link.
      const link = extractXmlTag(body, 'link').split('?')[0];
      const pubDate = extractXmlTag(body, 'pubDate');
      const published = pubDate ? new Date(pubDate) : null;
      return {
        title,
        url: link,
        summary: extractXmlTag(body, 'description'),
        source: domainFromUrl(link),
        publishedAt: published && !isNaN(published) ? published.toISOString() : new Date().toISOString()
      };
    })
    .filter((item) => item.title && item.url);
  console.log(`${logPrefix} ${symbol}: ${items.length} articles`);
  return items;
}

// Placera.se — Avanza's own Swedish financial-news site. Its general
// articles RSS needs no API key and no per-symbol lookup at all, so unlike
// Finnhub's general-news category it works even with no Finnhub key
// configured, and being Sweden/Nordic-focused it's a natural fit for an
// Avanza-centric portfolio. It's a general feed (not per-symbol), so
// /api/news/stocks-general matches it against held names the same way it
// already does for Finnhub's general feed (see matchHeldName below).
async function fetchPlaceraGeneralNews(logPrefix) {
  let res;
  try {
    res = await fetch('https://www.placera.se/artiklar/rss.xml', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
  } catch (err) {
    console.error(`${logPrefix} fetch threw: ${err.name} — ${err.message}`);
    return [];
  }
  if (!res.ok) {
    console.error(`${logPrefix} HTTP ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const blocks = xml.split('<item>').slice(1);
  const items = blocks
    .map((block) => {
      const body = block.split('</item>')[0];
      const title = extractXmlTag(body, 'title');
      const url = extractXmlTag(body, 'link');
      const pubDate = extractXmlTag(body, 'pubDate');
      const published = pubDate ? new Date(pubDate) : null;
      const summary = extractXmlTag(body, 'description')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      return {
        title,
        url,
        summary,
        source: 'Placera',
        publishedAt: published && !isNaN(published) ? published.toISOString() : new Date().toISOString()
      };
    })
    .filter((item) => item.title && item.url);
  console.log(`${logPrefix} ${items.length} articles`);
  return items;
}

const yahooSymbolCache = new Map();

// A broker's own display name for a position often carries a suffix that
// means something to a trader (which listing this is) but breaks a plain
// name search — confirmed live: Avanza's "Novo Nordisk ADR" (marking it as
// the US depositary-receipt listing) returned zero results from Yahoo's
// search below, while "Novo Nordisk" alone resolved straight to NVO.
const NAME_SUFFIX_STRIP_RE = /\b(ADR|ADS|SDR|ORD|SHS?)\b\.?$/i;

// Yahoo's own (undocumented, but free and keyless) symbol search — this is
// what lets stock news work with *no* Finnhub key at all: previously,
// every stock request 404'd at "keyMissing" before even trying Yahoo's own
// per-ticker feed, because resolving a name to a ticker in the first place
// went through resolveFinnhubSymbol exclusively. Finnhub's own resolution
// is still tried first when a key is present (see fetchStockNews below) —
// this is the fallback, not a replacement, since Finnhub's /search has its
// own tuned relevance logic already proven against this app's holdings.
async function resolveYahooSymbol(name) {
  const cleaned = name.replace(NAME_SUFFIX_STRIP_RE, '').trim() || name;
  if (yahooSymbolCache.has(cleaned)) return yahooSymbolCache.get(cleaned);

  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(cleaned)}&quotesCount=5&newsCount=0`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      console.error(`[news/stocks/yahoo-search] "${cleaned}": HTTP ${res.status}`);
      yahooSymbolCache.set(cleaned, null);
      return null;
    }
    const data = await res.json();
    const quotes = Array.isArray(data.quotes) ? data.quotes : [];
    // Prefer an actual equity (not an option/index/mutual fund/...) — among
    // those, the first result, since Yahoo already returns them ranked by
    // its own relevance score.
    const best = quotes.find((q) => q.quoteType === 'EQUITY') || quotes[0];
    const symbol = best?.symbol || null;
    console.log(`[news/stocks/yahoo-search] "${cleaned}" -> ${symbol || 'none'} (${best?.shortname || 'n/a'})`);
    yahooSymbolCache.set(cleaned, symbol);
    return symbol;
  } catch (err) {
    console.error(`[news/stocks/yahoo-search] "${cleaned}" threw:`, err.message);
    return null;
  }
}

// Yahoo's search endpoint (the same one resolveYahooSymbol above uses)
// also embeds up to newsCount news items directly in its response, each
// tagged with relatedTickers — a second, independently-sourced news feed
// beyond fetchYahooFinanceRss's per-ticker RSS, used as a further fallback
// (see MIN_ARTICLES_PER_ASSET below) when the RSS feed alone doesn't turn
// up enough. Confirmed live for ENB: five results, each correctly tagged.
//
// requiredSymbol is mandatory, not optional: confirmed live that when a
// query has no genuine match (tried a nonsense symbol), Yahoo doesn't
// return an empty news list — it falls back to unrelated trending
// articles (Tesla, Netflix, TSMC, ...) with an empty/irrelevant
// relatedTickers. Every result is filtered to actually carry
// requiredSymbol in relatedTickers before being trusted; with no
// filtering this function would happily manufacture "coverage" for an
// asset that has none, which is worse than admitting there's nothing —
// it would show the user news that has nothing to do with what they hold.
async function fetchYahooSearchNews(query, requiredSymbol, logPrefix, newsCount = 8) {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=${newsCount}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      console.error(`${logPrefix} "${query}": HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const news = Array.isArray(data.news) ? data.news : [];
    const wantedTickers = new Set([requiredSymbol.toUpperCase(), requiredSymbol.replace(/-USD$/i, '').toUpperCase()]);
    const items = news
      .filter((n) => (n.relatedTickers || []).some((t) => wantedTickers.has(String(t).toUpperCase())))
      .map((n) => ({
        title: n.title,
        url: n.link,
        summary: '',
        source: n.publisher || domainFromUrl(n.link),
        imageUrl: n.thumbnail?.resolutions?.[0]?.url || null,
        publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : new Date().toISOString()
      }))
      .filter((item) => item.title && item.url);
    console.log(`${logPrefix} "${query}": ${news.length} raw, ${items.length} actually tagged with ${requiredSymbol}`);
    return items;
  } catch (err) {
    console.error(`${logPrefix} "${query}" threw:`, err.message);
    return [];
  }
}

// Every stock/coin gets at least this many articles when the internet
// actually has that many to find — a genuinely obscure holding with zero
// real coverage anywhere still can't be conjured news for, but this is
// what makes the algorithm actually *try* multiple independent sources
// (Yahoo's RSS feed, then its search-embedded news, then Finnhub's
// company-news when a key is present) before giving up on one, rather
// than accepting whatever the first source happened to return.
const MIN_ARTICLES_PER_ASSET = 2;
const MAX_ARTICLES_PER_ASSET = 8;

// Tracks, per held stock name, how many refreshes in a row it's come up
// short of MIN_ARTICLES_PER_ASSET after the normal fallback chain — so a
// holding that's persistently hard to find news for gets escalated, wider
// (but still relevance-filtered) attempts on the *next* refresh instead of
// the algorithm running the same fixed 3 tries forever and quietly
// settling for less than every other stock gets. Reset to 0 the moment a
// name clears the minimum again. In-memory/per-process, same as the other
// news caches — resets on a server restart, which is fine since a fresh
// process starts every stock at "try normally first" anyway.
const stockCoverageMisses = new Map();

// Pushes items from `additional` onto `existing` (mutating it) up to
// maxTotal, skipping anything whose url is already present — shared by
// both /api/news/stocks and /api/news/crypto below, each of which layers
// 2-3 independent sources per symbol and needs the same "keep adding
// until there's enough, without duplicating an article two sources both
// happened to carry" merge behavior.
function mergeNewsItems(existing, additional, maxTotal) {
  const seenUrls = new Set(existing.map((item) => item.url));
  for (const item of additional) {
    if (existing.length >= maxTotal) break;
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    existing.push(item);
  }
  return existing;
}

// The per-symbol fetch loops above already work hard to get every held
// asset a real MIN_ARTICLES_PER_ASSET-sized slice of coverage — but a
// plain `items.sort(newest-first).slice(0, N)` on the *combined* list
// throws all of that away for any portfolio with more than a couple
// assets: confirmed live with an 11-coin crypto portfolio where the
// server successfully fetched 11-20 articles for every single coin, yet a
// blind top-40-by-recency cut let only 4 heavily-covered ones (ETH, SOL,
// XRP, USDT) survive into the response. Round-robining one article per
// asset (each asset's own articles already newest-first) instead means an
// asset with any real coverage always claims a slot before a "louder"
// asset gets a second, so the fetch effort above actually reaches the
// client instead of being discarded at the last step.
function capFairlyByAsset(items, maxTotal) {
  const groups = new Map();
  const order = [];
  for (const item of items) {
    const key = item.assetSymbol || `unattributed-${item.assetType || ''}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(item);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  }
  const result = [];
  for (let round = 0; result.length < maxTotal; round++) {
    let addedAny = false;
    for (const key of order) {
      if (result.length >= maxTotal) break;
      const list = groups.get(key);
      if (round < list.length) {
        result.push(list[round]);
        addedAny = true;
      }
    }
    if (!addedAny) break;
  }
  return result;
}

function normalizeForMatch(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}

// A holding company's name often reduces to exactly one significant word
// after stripping its share-class suffix ("Investor B" -> "INVESTOR"), and
// some of those words are also just common financial vocabulary — matching
// on that word alone false-positives constantly. Confirmed directly: a
// held "Investor B" (a real, well-known Swedish holding company on
// Avanza) matched "Investor's guide to the housing market", a completely
// unrelated headline. These are excluded from counting as a lone
// distinguishing word, the same way resolveFinnhubSymbol's own 1-word
// fallback below already treats "Global"/"Defence" as too generic to
// trust alone.
const COMMON_FINANCIAL_WORDS = new Set([
  'INVESTOR', 'INVESTORS', 'GLOBAL', 'GENERAL', 'GROUP', 'HOLDING', 'HOLDINGS',
  'CAPITAL', 'INDUSTRY', 'INDUSTRIES', 'PARTNERS', 'VENTURES', 'GROWTH', 'VALUE'
]);

// Tags an otherwise-unattributed article (general-market news, no symbol
// of its own) with a held stock's ticker if the headline actually names
// that company — so a "Market" item that happens to be about something
// specifically held shows its ticker instead of nothing. Requires every
// significant word of the held name to appear in the title, not just one,
// and (per COMMON_FINANCIAL_WORDS above) refuses to match on a single word
// that's too generic to trust alone even when it's the name's only
// significant word.
function matchHeldName(title, heldNames) {
  const titleWords = new Set(normalizeForMatch(title));
  for (const name of heldNames) {
    const nameWords = normalizeForMatch(name).filter((w) => w.length > 2);
    if (!nameWords.length) continue;
    if (nameWords.length === 1 && COMMON_FINANCIAL_WORDS.has(nameWords[0])) continue;
    if (nameWords.every((w) => titleWords.has(w))) return name;
  }
  return null;
}

async function finnhubSearch(query, apiKey) {
  const res = await fetch(`${FINNHUB_BASE}/search?q=${encodeURIComponent(query)}&token=${apiKey}`);
  const data = await res.json();
  return data.result || [];
}

async function resolveFinnhubSymbol(name, apiKey) {
  if (finnhubSymbolCache.has(name)) return finnhubSymbolCache.get(name);
  const lastFailure = finnhubSymbolFailureCache.get(name);
  if (lastFailure && Date.now() - lastFailure < SYMBOL_FAILURE_COOLDOWN_MS) {
    console.log(`[news/stocks] resolve "${name}" skipped — recent failure, cooling down`);
    return null;
  }
  try {
    const queryWords = normalizeForMatch(name).filter((w) => w.length > 2);

    // Finnhub's search wants something close to the company's actual name or
    // ticker — a long, verbose free-text position name (e.g. an exchange's
    // full display name) can come back completely empty even for a large,
    // well-known company. Retry with progressively shorter prefixes of the
    // name (2 words, then 1) before giving up. The 1-word fallback is
    // skipped unless that word is reasonably distinctive (>=5 chars) — a
    // short generic word ("Global", "Defence", ...) matched an unrelated
    // company by coincidence during testing (Global X Defence Tech UCITS ETF
    // → an unrelated Indian company called Global Defence Industries).
    let results = await finnhubSearch(name, apiKey);
    let queryUsed = name;
    for (let wordCount = 2; !results.length && wordCount >= 1 && queryWords.length > wordCount; wordCount--) {
      if (wordCount === 1 && queryWords[0].length < 5) break;
      queryUsed = queryWords.slice(0, wordCount).join(' ');
      results = await finnhubSearch(queryUsed, apiKey);
    }

    // Finnhub's search is fuzzy and can surface loosely-related tickers
    // alongside (or instead of) the actual company — only trust a result
    // whose own description shares a real word with the name being looked
    // up, so an unrelated small-cap with a "nicer" plain symbol doesn't get
    // picked over (or in place of) the company actually being searched for.
    const matching = results.filter((r) => {
      const descWords = normalizeForMatch(r.description);
      return queryWords.some((w) => descWords.includes(w));
    });
    const pool = matching.length ? matching : results;

    // Among genuine matches, Finnhub's free tier only allows /company-news
    // for US-primary-listed symbols — a foreign listing (suffixed like
    // "ENB.TO") resolves here but then 403s on the news call, so prefer a
    // plain-format (no ".XX" suffix) listing when the company has one.
    const isPlainUSSymbol = (r) => /^[A-Z]+$/.test(r.symbol || '');
    const best =
      pool.find((r) => r.type === 'Common Stock' && isPlainUSSymbol(r)) ||
      pool.find((r) => isPlainUSSymbol(r)) ||
      pool.find((r) => r.type === 'Common Stock') ||
      pool[0];
    const symbol = best?.symbol || null;
    console.log(`[news/stocks] resolve "${name}" (query "${queryUsed}") -> ${symbol || 'none'} (${best?.description || 'n/a'}) — ${results.length} raw, ${matching.length} name-matched`);
    finnhubSymbolCache.set(name, symbol);
    return symbol;
  } catch (err) {
    console.error(`[news/stocks] resolve "${name}" threw:`, err.message);
    finnhubSymbolFailureCache.set(name, Date.now());
    return null;
  }
}

// symbols: every coin currently held (e.g. "BTC", "ETH", "SOL") — each gets
// its own Yahoo Finance RSS feed via the "{SYMBOL}-USD" ticker convention,
// which is genuinely per-coin (unlike Finnhub's free /news?category=crypto,
// which has no symbol filter at all), then Yahoo's search-embedded news
// too if the RSS feed alone didn't reach MIN_ARTICLES_PER_ASSET — two
// independent Yahoo sources so a coin with thin RSS coverage still gets a
// real attempt at more rather than being left with whatever the first
// source happened to have. Finnhub's general crypto feed is still fetched
// too, as a "top crypto market news" supplement alongside the per-coin
// results — the same two-layer treatment /api/news/stocks and
// /api/news/stocks-general give stocks. Doesn't need a Finnhub key at all
// for the per-coin half; only the supplementary general layer does.
// No practical cap on symbols — every held coin gets attempted, not just
// however many fit under an arbitrary slice.
app.get('/api/news/crypto', async (req, res) => {
  const apiKey = req.query.key || process.env.FINNHUB_API_KEY;
  const symbols = [].concat(req.query.symbols || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean).slice(0, 40);

  if (!symbols.length) return res.json({ items: [] });

  const cacheKey = `${apiKey || ''}:${[...symbols].sort().join(',')}`;
  const cached = newsCacheGet(cryptoNewsCache, cacheKey);
  if (cached) return res.json({ items: cached });

  const items = [];

  for (const symbol of symbols) {
    const toItem = (source) => (item) => ({
      id: newsIdFromUrl(`crypto-${source}-${symbol}`, item.url),
      title: item.title,
      summary: item.summary,
      url: item.url,
      imageUrl: item.imageUrl || null,
      source: item.source,
      publishedAt: item.publishedAt,
      assetSymbol: symbol,
      assetType: 'crypto'
    });

    let coinItems = (await fetchYahooFinanceRss(`${symbol}-USD`, '[news/crypto/yahoo-rss]'))
      .slice(0, MAX_ARTICLES_PER_ASSET)
      .map(toItem('yh'));

    if (coinItems.length < MIN_ARTICLES_PER_ASSET) {
      const searchItems = await fetchYahooSearchNews(`${symbol}-USD`, symbol, '[news/crypto/yahoo-search]');
      coinItems = mergeNewsItems(coinItems, searchItems.map(toItem('ys')), MAX_ARTICLES_PER_ASSET);
    }

    items.push(...coinItems);
  }

  if (apiKey) {
    try {
      const apiRes = await fetch(`${FINNHUB_BASE}/news?category=crypto&token=${encodeURIComponent(apiKey)}`);
      if (apiRes.status !== 401 && apiRes.status !== 403) {
        const data = await apiRes.json();
        if (Array.isArray(data)) {
          items.push(
            ...data.map((item) => ({
              id: `crypto-${item.id}`,
              title: item.headline,
              summary: item.summary,
              url: item.url,
              imageUrl: item.image || null,
              source: item.source || 'Unknown',
              publishedAt: new Date(item.datetime * 1000).toISOString(),
              assetSymbol: null,
              assetType: 'crypto'
            }))
          );
        }
      }
    } catch (err) {
      console.error('crypto news (finnhub general) error:', err);
    }
  }

  const capped = capFairlyByAsset(items, 200);
  // Only cache a real result — caching an empty one (e.g. a transient
  // failure right after a cold server start) would stick for the full
  // NEWS_CACHE_TTL_MS and show "0 news" for 5 minutes even once the
  // underlying sources are reachable again.
  if (capped.length) cryptoNewsCache = { key: cacheKey, data: capped, fetchedAt: Date.now() };
  res.json({ items: capped });
});

// Fetches one symbol's company-news and returns it already normalized.
// 401 (bad/missing token) and 403 (valid token, but the free tier doesn't
// entitle it to this particular symbol — confirmed live for foreign
// listings like ENB.TO/NOVO B.CO/2330.TW) used to be treated identically
// as "unauthorized" and both surfaced to the client as keyInvalid, which
// wrongly told a user with a perfectly good key that it looked bad just
// because their (likely non-US, e.g. Avanza) holdings hit the 403 case.
// invalidKey now only reflects the actual 401 case.
async function fetchCompanyNews(symbol, apiKey, fmt, from, to, logPrefix) {
  if (finnhubUnauthorizedSymbols.has(symbol)) {
    return { items: [], unauthorized: true, invalidKey: false };
  }

  const newsUrl = `${FINNHUB_BASE}/company-news?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}&token=${apiKey}`;
  let res2;
  try {
    res2 = await fetch(newsUrl, { signal: AbortSignal.timeout(10000) });
  } catch (fetchErr) {
    console.error(`${logPrefix} ${symbol}: fetch threw: ${fetchErr.name} — ${fetchErr.message}`);
    return { items: [], unauthorized: false, invalidKey: false };
  }
  if (res2.status === 401 || res2.status === 403) {
    const body = await res2.text().catch(() => '');
    console.error(`${logPrefix} ${symbol}: unauthorized (${res2.status}) — ${body.slice(0, 200)}`);
    finnhubUnauthorizedSymbols.add(symbol);
    return { items: [], unauthorized: true, invalidKey: res2.status === 401 };
  }
  if (!res2.ok) {
    const body = await res2.text().catch(() => '');
    console.error(`${logPrefix} ${symbol}: HTTP ${res2.status} — ${body.slice(0, 300)}`);
    return { items: [], unauthorized: false, invalidKey: false };
  }
  const data = await res2.json();
  console.log(`${logPrefix} ${symbol}: status=${res2.status} articles=${Array.isArray(data) ? data.length : 'not-an-array: ' + JSON.stringify(data).slice(0, 200)}`);
  if (!Array.isArray(data)) return { items: [], unauthorized: false, invalidKey: false };
  return { items: data, unauthorized: false, invalidKey: false };
}

function dateRangeParams() {
  const to = new Date();
  const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from, to, fmt };
}

// names: array of held stock display names (e.g. Avanza position names) —
// funds/ETFs are excluded client-side (a fund has no "company news" of its
// own to match against — see getHeldStockNames in app.js). Each name is
// resolved to a ticker via Finnhub's symbol search when a key is present
// (richer results — real summaries/images, and it's already proven tuned
// against this app's holdings), falling back to Yahoo's own free search
// otherwise (or when Finnhub simply doesn't have a match) — this is what
// makes stock news work with *no* Finnhub key at all, the same as crypto
// already does, rather than returning nothing before even trying. Layers
// keep going per name until MIN_ARTICLES_PER_ASSET is reached or every
// source is exhausted — Finnhub's company-news alone (even when it does
// return something) isn't treated as automatically "enough" the way it
// used to be, since 1 article for a well-covered US stock while a barely-
// covered one gets 0 isn't the "at least 1-2 for every single holding"
// this is meant to guarantee. No practical cap on names either, for the
// same reason: every held stock gets attempted, not just however many
// fit under an arbitrary slice.
app.get('/api/news/stocks', async (req, res) => {
  const apiKey = req.query.key || process.env.FINNHUB_API_KEY;
  const names = [].concat(req.query.names || []).map((n) => String(n).trim()).filter(Boolean).slice(0, 40);

  if (!names.length) return res.json({ items: [] });

  const cacheKey = `${apiKey || ''}:${[...names].sort().join(',')}`;
  const cached = newsCacheGet(stockNewsCache, cacheKey);
  if (cached) return res.json({ items: cached });

  const { from, to, fmt } = dateRangeParams();

  try {
    let sawInvalidKey = false;
    const items = [];

    // Sequential, not Promise.allSettled(names.map(...)) — firing 7+
    // simultaneous connections at finnhub.io from this environment was
    // silently hanging past any timeout (the one company-news request that
    // got past symbol resolution never resolved, rejected, or logged
    // anything, even with an 8s AbortSignal). One name at a time is slower
    // (a few seconds total instead of one round trip) but actually completes.
    for (const name of names) {
      const finnhubSymbol = apiKey ? await resolveFinnhubSymbol(name, apiKey) : null;
      let stockItems = [];

      if (finnhubSymbol) {
        const { items: rawItems, invalidKey } = await fetchCompanyNews(finnhubSymbol, apiKey, fmt, from, to, '[news/stocks]');
        if (invalidKey) sawInvalidKey = true;
        stockItems = rawItems.slice(0, MAX_ARTICLES_PER_ASSET).map((item) => ({
          id: `stock-${item.id}`,
          title: item.headline,
          summary: item.summary,
          url: item.url,
          imageUrl: item.image || null,
          source: item.source || 'Unknown',
          publishedAt: new Date(item.datetime * 1000).toISOString(),
          assetSymbol: finnhubSymbol,
          assetName: name,
          assetType: 'stock'
        }));
      }

      const priorMisses = stockCoverageMisses.get(name) || 0;

      // Finnhub's own resolution can land on a foreign/regional listing
      // (e.g. "NOVO B.CO" for Novo Nordisk's Danish primary listing,
      // malformed with a literal space, instead of the US-traded "NVO"
      // ADR) that Yahoo's own RSS/search then don't recognize as a ticker
      // at all under that exact string — confirmed live: Finnhub resolved
      // "Novo Nordisk ADR" to "NOVO B.CO" and every Yahoo tier under that
      // symbol came back completely empty, even though Yahoo's own
      // resolver correctly gets "NVO" for that same name (and does, with
      // no Finnhub key involved at all). So the canonical symbol used for
      // every Yahoo-based tier below, and for the final article tags,
      // always prefers Yahoo's own resolution over Finnhub's when the two
      // disagree — Finnhub's pick still drove its own company-news call
      // above, it just doesn't get to poison the independent Yahoo
      // attempts that follow it.
      const yahooSymbol = await resolveYahooSymbol(name);
      let symbol = yahooSymbol || finnhubSymbol;

      // Escalated retry (see stockCoverageMisses above): this name has
      // fallen short before, so before giving up on it *again* for lack
      // of any resolvable symbol, try just its first significant word
      // (e.g. "Novo" instead of the full "Novo Nordisk ADR") — a longer,
      // more literal name is exactly what trips up Yahoo's search.
      if (!symbol && priorMisses > 0) {
        const firstWord = name.split(/\s+/)[0];
        if (firstWord && firstWord !== name) symbol = await resolveYahooSymbol(firstWord);
      }

      if (!symbol) {
        stockCoverageMisses.set(name, priorMisses + 1);
        items.push(...stockItems);
        continue;
      }

      // Keep everything for this name under one consistent symbol/badge
      // instead of fragmenting into two "assets" — retag whatever
      // Finnhub's company-news call above already collected if the
      // canonical symbol chosen ended up different from Finnhub's pick.
      if (stockItems.length && symbol !== finnhubSymbol) {
        stockItems = stockItems.map((item) => ({ ...item, assetSymbol: symbol }));
      }

      const toItem = (source) => (item) => ({
        id: newsIdFromUrl(`stock-${source}-${symbol}`, item.url),
        title: item.title,
        summary: item.summary,
        url: item.url,
        imageUrl: item.imageUrl || null,
        source: item.source,
        publishedAt: item.publishedAt,
        assetSymbol: symbol,
        assetName: name,
        assetType: 'stock'
      });

      if (stockItems.length < MIN_ARTICLES_PER_ASSET) {
        const rssItems = await fetchYahooFinanceRss(symbol, '[news/stocks/yahoo-rss]');
        stockItems = mergeNewsItems(stockItems, rssItems.map(toItem('yh')), MAX_ARTICLES_PER_ASSET);
      }

      if (stockItems.length < MIN_ARTICLES_PER_ASSET) {
        const searchItems = await fetchYahooSearchNews(symbol, symbol, '[news/stocks/yahoo-search]');
        stockItems = mergeNewsItems(stockItems, searchItems.map(toItem('ys')), MAX_ARTICLES_PER_ASSET);
      }

      // Escalated retries — only spent on a name that's already missed the
      // minimum on a prior refresh, so a stock that's easy to cover never
      // pays for this extra work. Every one of these still goes through
      // fetchYahooSearchNews's relatedTickers relevance filter, so casting
      // a wider net here can't reintroduce the "unrelated filler news"
      // problem that filter exists to prevent — it just gives the filter
      // more raw candidates, and more query phrasings, to find a real
      // match in.
      if (stockItems.length < MIN_ARTICLES_PER_ASSET && priorMisses > 0) {
        const widerSearch = await fetchYahooSearchNews(symbol, symbol, '[news/stocks/yahoo-search-wide]', 20);
        stockItems = mergeNewsItems(stockItems, widerSearch.map(toItem('ysw')), MAX_ARTICLES_PER_ASSET);
      }
      if (stockItems.length < MIN_ARTICLES_PER_ASSET && priorMisses > 0 && name !== symbol) {
        const nameSearch = await fetchYahooSearchNews(name, symbol, '[news/stocks/yahoo-search-name]', 20);
        stockItems = mergeNewsItems(stockItems, nameSearch.map(toItem('ysn')), MAX_ARTICLES_PER_ASSET);
      }
      if (stockItems.length < MIN_ARTICLES_PER_ASSET && priorMisses > 0 && apiKey && !finnhubSymbol) {
        // Finnhub was never tried for this one (no Finnhub symbol match
        // originally) — now that Yahoo has resolved a symbol for it,
        // give Finnhub's company-news a shot under that symbol too.
        const { items: rawItems } = await fetchCompanyNews(symbol, apiKey, fmt, from, to, '[news/stocks/finnhub-retry]');
        stockItems = mergeNewsItems(
          stockItems,
          rawItems.slice(0, MAX_ARTICLES_PER_ASSET).map((item) => ({
            id: `stock-${item.id}`,
            title: item.headline,
            summary: item.summary,
            url: item.url,
            imageUrl: item.image || null,
            source: item.source || 'Unknown',
            publishedAt: new Date(item.datetime * 1000).toISOString(),
            assetSymbol: symbol,
            assetName: name,
            assetType: 'stock'
          })),
          MAX_ARTICLES_PER_ASSET
        );
      }

      if (stockItems.length < MIN_ARTICLES_PER_ASSET) {
        const misses = priorMisses + 1;
        stockCoverageMisses.set(name, misses);
        if (misses >= 3) {
          console.warn(`[news/stocks] "${name}" has come up short of ${MIN_ARTICLES_PER_ASSET} articles for ${misses} refreshes in a row (has ${stockItems.length})`);
        }
      } else {
        stockCoverageMisses.delete(name);
      }

      items.push(...stockItems);
    }

    // Only a real 401 (bad/missing token) counts as "your key looks
    // invalid" — a symbol 403ing because the free tier doesn't cover it
    // (routine for non-US listings) is not a key problem, so it no longer
    // trips this.
    if (!items.length && sawInvalidKey) {
      return res.json({ items: [], keyInvalid: true });
    }

    const capped = capFairlyByAsset(items, 200);
    // Same reasoning as the crypto endpoint above: don't cache an empty
    // result, or a cold-start hiccup shows "0 news" for the full TTL.
    if (capped.length) stockNewsCache = { key: cacheKey, data: capped, fetchedAt: Date.now() };
    res.json({ items: capped });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load stock news.' });
  }
});

// A fund/ETF holdings-based news feature (look up each fund's top underlying
// companies, show news for those) was attempted and reverted — Finnhub's
// /etf/holdings endpoint returns 403 "no access" on the free tier regardless
// of the resolved symbol, confirmed live against two different ETF matches.
// It's a paid-plan-only endpoint, not something resolvable in code.

// General top market/business news — Finnhub's /news?category=general (when
// a key is configured) plus Placera's general articles RSS (always, no key
// needed — see fetchPlaceraGeneralNews). Most held stocks here are non-US
// listings (this app is Avanza-centric), and /company-news 403s on the free
// tier for those (see fetchCompanyNews) regardless of how well the symbol
// resolved, so broad top news alongside whatever company-specific matches
// do succeed means a portfolio of entirely non-US stocks still sees
// *something* here instead of an empty panel — and Placera's Nordic focus
// specifically helps a Swedish/Avanza-listed portfolio like this one.
// names, when given, are matched against each headline from both sources
// (see matchHeldName) so a "general" article that happens to actually be
// about one of your holdings gets that ticker instead of showing as generic.
app.get('/api/news/stocks-general', async (req, res) => {
  const apiKey = req.query.key || process.env.FINNHUB_API_KEY;
  const hasStocks = req.query.hasStocks === '1';
  const names = [].concat(req.query.names || []).map((n) => String(n).trim()).filter(Boolean).slice(0, 40);

  if (!hasStocks) return res.json({ items: [] });

  const cacheKey = `${apiKey || ''}:${[...names].sort().join(',')}`;
  const cached = newsCacheGet(marketNewsCache, cacheKey);
  if (cached) return res.json({ items: cached });

  try {
    const items = [];
    let keyInvalid = false;

    if (apiKey) {
      const apiRes = await fetch(`${FINNHUB_BASE}/news?category=general&token=${encodeURIComponent(apiKey)}`);
      if (apiRes.status === 401) {
        keyInvalid = true;
      } else {
        const data = await apiRes.json();
        if (Array.isArray(data)) {
          for (const item of data) {
            // resolveFinnhubSymbol is cache-backed (see finnhubSymbolCache),
            // so this only costs a real request the first time a given
            // held name is matched — every later match (this refresh or a
            // future one) is free.
            const matchedName = names.length ? matchHeldName(item.headline, names) : null;
            const matchedSymbol = matchedName ? await resolveFinnhubSymbol(matchedName, apiKey) : null;
            items.push({
              id: `market-${item.id}`,
              title: item.headline,
              summary: item.summary,
              url: item.url,
              imageUrl: item.image || null,
              source: item.source || 'Unknown',
              publishedAt: new Date(item.datetime * 1000).toISOString(),
              assetSymbol: matchedSymbol,
              assetName: matchedName,
              assetType: 'market'
            });
          }
        }
      }
    }

    const placeraItems = await fetchPlaceraGeneralNews('[news/stocks-general/placera]');
    for (const item of placeraItems) {
      const matchedName = names.length ? matchHeldName(item.title, names) : null;
      const matchedSymbol = matchedName
        ? (apiKey ? await resolveFinnhubSymbol(matchedName, apiKey) : await resolveYahooSymbol(matchedName))
        : null;
      items.push({
        id: newsIdFromUrl('market-placera', item.url),
        title: item.title,
        summary: item.summary,
        url: item.url,
        imageUrl: null,
        source: item.source,
        publishedAt: item.publishedAt,
        assetSymbol: matchedSymbol,
        assetName: matchedName,
        assetType: 'market'
      });
    }

    if (!items.length && keyInvalid) {
      return res.json({ items: [], keyInvalid: true });
    }

    items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const capped = items.slice(0, 40);
    if (capped.length) marketNewsCache = { key: cacheKey, data: capped, fetchedAt: Date.now() };
    res.json({ items: capped, keyMissing: !apiKey });
  } catch (err) {
    console.error('general market news error:', err);
    res.status(500).json({ error: err.message || 'Failed to load market news.' });
  }
});

// The original single-user server bound to 127.0.0.1 only, by design (it
// was never meant to be reached from anywhere but its own machine). This
// relay is meant to be reachable by whoever's using the web/ build, so it
// binds to every interface unless told otherwise — HOST lets a deploy
// target override that (e.g. a platform that expects a specific bind
// address), and defaults to 127.0.0.1 for local dev so `node server.js`
// on a laptop doesn't unexpectedly expose it to the local network.
// Different default port than the original app's server.js (3001) — the
// import-from-existing-Tradone flow (see app.js) needs both servers
// running at once against this same machine during a migration, so they
// can't share a port.
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Tradone relay running → http://${HOST}:${PORT}`);
});
