/**
 * Passport configuration for social sign-in.
 *
 * Strategies are registered ONLY when their credentials exist. Without them the
 * module still loads and the routes answer a clean 503 instead of crashing the
 * process at boot — a missing OAuth key must never take the API down.
 */
const passport = require('passport');

let googleEnabled = false;
let githubEnabled = false;

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback',
        scope: ['profile', 'email']
      },
      (accessToken, refreshToken, profile, done) => done(null, { provider: 'google', profile })
    )
  );
  googleEnabled = true;
}

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  const GitHubStrategy = require('passport-github2').Strategy;
  const { fetchVerifiedEmails } = require('../services/githubEmailService');

  passport.use(
    new GitHubStrategy(
      {
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL: process.env.GITHUB_CALLBACK_URL || '/api/auth/github/callback',
        scope: ['user:email']
      },
      async (accessToken, refreshToken, profile, done) => {
        // `/user` carries no verification flag; ask `/user/emails` so linking
        // can rely on an address GitHub actually vouched for.
        const emails = await fetchVerifiedEmails(accessToken);
        const enriched = emails && emails.length ? { ...profile, emails } : profile;
        done(null, { provider: 'github', profile: enriched });
      }
    )
  );
  githubEnabled = true;
}

module.exports = { passport, googleEnabled, githubEnabled };
