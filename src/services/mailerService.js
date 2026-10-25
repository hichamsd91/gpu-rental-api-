/**
 * Mailer service — transactional email with a dev-safe fallback.
 *
 * In production it sends through SMTP (the EMAIL_* env vars). When those are
 * absent (local dev, tests) it logs the would-be email instead of failing:
 * sending an email must never break the request that triggered it.
 *
 * Deliverability (SPF/DKIM/DMARC) is the owner's responsibility (plan M2); this
 * module only proves the message can be handed to a transport.
 */
const nodemailer = require('nodemailer');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://veloxora-app.web.app';

const isConfigured = () =>
  Boolean(
    (process.env.EMAIL_SERVICE || process.env.EMAIL_HOST) &&
    process.env.EMAIL_USER &&
    process.env.EMAIL_PASSWORD
  );

let transporter = null;
const getTransporter = () => {
  if (!transporter && isConfigured()) {
    transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || undefined,
      host: process.env.EMAIL_HOST || undefined,
      port: process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : undefined,
      secure: process.env.EMAIL_PORT === '465',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
    });
  }
  return transporter;
};

const send = async ({ to, subject, text, html }) => {
  if (!isConfigured()) {
    console.log(`[mailer:dev] to=${to} subject="${subject}"`);
    return { sent: false, reason: 'not-configured' };
  }
  try {
    const info = await getTransporter().sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to,
      subject,
      text,
      html
    });
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    console.error('mailer send failed:', error.message || String(error));
    return { sent: false, reason: error.message || String(error) };
  }
};

const sendVerificationEmail = (to, token) => {
  const link = `${FRONTEND_URL}/#/verify-email?token=${encodeURIComponent(token)}`;
  return send({
    to,
    subject: 'Veloxora — تأكيد بريدك الإلكتروني / Verify your email',
    text: `أكّد بريدك بالرابط: ${link}\nConfirm your email: ${link}`,
    html: `<p>اضغط لتأكيد بريدك / Verify your email:</p><p><a href="${link}">${link}</a></p>`
  });
};

const sendPasswordResetEmail = (to, token) => {
  const link = `${FRONTEND_URL}/#/reset-password?token=${encodeURIComponent(token)}`;
  return send({
    to,
    subject: 'Veloxora — إعادة تعيين كلمة المرور / Reset your password',
    text: `أعد تعيين كلمتك بالرابط (صالح 24 ساعة): ${link}\nReset your password: ${link}`,
    html: `<p>أعد تعيين كلمتك / Reset your password:</p><p><a href="${link}">${link}</a></p>`
  });
};

module.exports = { send, sendVerificationEmail, sendPasswordResetEmail, isConfigured };
