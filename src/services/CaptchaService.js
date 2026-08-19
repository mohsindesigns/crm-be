const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Self-hosted math captcha for the public lead-form embed — no external
// account/API keys needed. Stateless (no server-side store): the expected
// answer never travels to the client in the clear, only an HMAC of it keyed
// by JWT_SECRET, sealed inside a short-lived JWT the client echoes back on
// submit. A bot can't derive the answer from the token without the secret,
// and a solved token can't be replayed past its TTL.
const CAPTCHA_TTL = '5m';

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function hashAnswer(answer, salt) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${salt}:${answer}`).digest('hex');
}

function generate() {
  const a = 1 + Math.floor(Math.random() * 9);
  const b = 1 + Math.floor(Math.random() * 9);
  const salt = crypto.randomBytes(8).toString('hex');
  const captchaToken = jwt.sign({ salt, ans: hashAnswer(a + b, salt) }, process.env.JWT_SECRET, { expiresIn: CAPTCHA_TTL });
  return { question: `${a} + ${b} = ?`, captchaToken };
}

function verify(captchaToken, answer) {
  if (!captchaToken || answer === undefined || answer === null || String(answer).trim() === '') {
    throw badRequest('Please complete the captcha.');
  }
  let payload;
  try {
    payload = jwt.verify(captchaToken, process.env.JWT_SECRET);
  } catch {
    throw badRequest('Captcha expired — please try again.');
  }
  if (hashAnswer(String(answer).trim(), payload.salt) !== payload.ans) {
    throw badRequest('That captcha answer isn\'t right — please try again.');
  }
}

module.exports = { generate, verify };
