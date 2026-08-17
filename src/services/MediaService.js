const https = require('https');
const http = require('http');
const FormData = require('form-data');

const MEDIA_URL = process.env.MEDIA_URL || 'http://localhost:3002';
const MEDIA_API_SECRET = process.env.MEDIA_API_SECRET || '';

function request(method, path, headers = {}, body = null) {
  const url = new URL(`${MEDIA_URL}${path}`);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method,
        headers: { 'x-api-key': MEDIA_API_SECRET, ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
            else reject(Object.assign(new Error(parsed.error || `Media server ${res.statusCode}`), { status: res.statusCode }));
          } catch {
            reject(new Error('Invalid response from media server'));
          }
        });
      }
    );
    req.on('error', reject);
    if (body) body.pipe(req);
    else req.end();
  });
}

/**
 * Upload a buffer to the media server.
 * @param {Buffer} buffer
 * @param {string} originalName
 * @param {string} mimetype
 */
async function upload(buffer, originalName, mimetype) {
  const form = new FormData();
  form.append('file', buffer, { filename: originalName, contentType: mimetype });
  return request('POST', '/upload', form.getHeaders(), form);
}

/**
 * Delete a file from the media server by filename.
 * @param {string} filename
 */
async function remove(filename) {
  return request('DELETE', `/upload/${encodeURIComponent(filename)}`);
}

module.exports = { upload, remove };
