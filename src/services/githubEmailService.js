/**
 * GitHub email lookup for OAuth sign-in.
 *
 * GitHub's `/user` payload never says whether an address is verified, and it
 * only exposes a public one. `/user/emails` (granted by the `user:email` scope)
 * is the only place the provider states `verified` / `primary`, so account
 * linking asks it explicitly instead of assuming anything.
 *
 * Failures are soft: a lookup error returns `null` and the caller falls back to
 * whatever the basic profile carried, rather than breaking sign-in.
 */
const EMAILS_URL = 'https://api.github.com/user/emails';

const fetchVerifiedEmails = async (accessToken, { fetchImpl = fetch } = {}) => {
  if (!accessToken || typeof accessToken !== 'string') return null;

  try {
    const response = await fetchImpl(EMAILS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Veloxora-API'
      }
    });

    if (!response || !response.ok) return null;

    const list = await response.json();
    if (!Array.isArray(list)) return null;

    return list
      .filter((entry) => entry && typeof entry.email === 'string' && entry.email.includes('@'))
      .map((entry) => ({
        value: entry.email.trim().toLowerCase(),
        primary: entry.primary === true,
        verified: entry.verified === true
      }));
  } catch (error) {
    console.warn('[github] email lookup failed:', error && error.message ? error.message : String(error));
    return null;
  }
};

module.exports = { fetchVerifiedEmails };
