// Cloudflare Turnstile verification for the public lead-form and
// client-requirement embeds. The widget runs entirely client-side (see
// crm-fe's LeadFormRenderer) and hands back an opaque response token that
// the browser submits alongside the form; this just checks that token with
// Cloudflare's siteverify endpoint before letting the submission through.
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

async function verify(token, remoteIp) {
  if (!token || typeof token !== 'string') {
    throw badRequest('Please complete the verification challenge.');
  }
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Misconfiguration, not a client error — fail loudly in logs rather than
    // silently letting every submission through unverified.
    throw Object.assign(new Error('TURNSTILE_SECRET_KEY is not configured.'), { status: 500 });
  }

  const params = new URLSearchParams({ secret, response: token });
  if (remoteIp) params.set('remoteip', remoteIp);

  let result;
  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body: params });
    result = await res.json();
  } catch {
    throw badRequest('Could not verify the challenge — please try again.');
  }

  if (!result?.success) {
    throw badRequest('Verification failed — please try again.');
  }
}

module.exports = { verify };
