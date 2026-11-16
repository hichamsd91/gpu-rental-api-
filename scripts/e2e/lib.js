// Shared helpers for the local end-to-end money scenarios.
//
// These scripts exist because money bugs do not show up in unit tests: they
// need two real accounts, a real wallet, a real listing and a real API. They
// run against a LOCAL server (default http://127.0.0.1:5000/api) and create
// throw-away fixtures on the same database the server uses, so never point
// them at production with real money in it.
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5000/api';

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

// Fixture identity: clearly marked so `purge.js` can find and delete it.
const EMAIL = {
  renter: 'renter.test@veloxora-test.dev',
  provider: 'provider.test@veloxora-test.dev'
};
const PASSWORD = 'VeloxoraTest!2026';

async function ensureUser(role) {
  const email = EMAIL[role];
  const register = await call('POST', '/auth/register', {
    body: { email, password: PASSWORD, fullName: `Veloxora ${role} fixture`, role }
  });
  if (register.status === 201) return { role, email, ...register.body, created: true };
  if (register.status === 400) {
    const login = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
    if (login.status !== 200) throw new Error(`login failed for ${email}: ${login.status} ${JSON.stringify(login.body)}`);
    return { role, email, ...login.body, created: false };
  }
  throw new Error(`register failed for ${email}: ${register.status} ${JSON.stringify(register.body)}`);
}

module.exports = { BASE, call, EMAIL, PASSWORD, ensureUser };
