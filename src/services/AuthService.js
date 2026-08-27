const jwt = require('jsonwebtoken');
const { User, Role, WhiteLabelConfig, Worker } = require('../models');
const CaptchaService = require('./CaptchaService');

const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';

class AuthService {
  issueTokens(userId) {
    const access = jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: ACCESS_TTL });
    const refresh = jwt.sign({ sub: userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_TTL });
    return { access, refresh };
  }

  async login(email, password, turnstileToken, ip) {
    await CaptchaService.verify(turnstileToken, ip);

    const user = await User.findOne({
      where: { email: email.toLowerCase() },
      include: [{ model: Role, as: 'role' }],
    });

    if (!user) {
      const err = new Error('Invalid credentials.');
      err.status = 401;
      throw err;
    }

    const valid = await user.verifyPassword(password);
    if (!valid) {
      const err = new Error('Invalid credentials.');
      err.status = 401;
      throw err;
    }

    if (!user.isActive) {
      const err = new Error('Account is inactive. Contact your administrator.');
      err.status = 403;
      throw err;
    }

    const roleKey = user.role?.key;
    if (!['super_admin', 'admin'].includes(roleKey)) {
      const worker = await Worker.findOne({
        where: { userId: user.id, orgId: user.orgId },
        attributes: ['status'],
      });
      if (worker?.status === 'inactive') {
        const err = new Error('Your employee account is inactive. Contact your administrator.');
        err.status = 403;
        throw err;
      }
    }

    await user.update({ lastLoginAt: new Date() });

    const tokens = this.issueTokens(user.id);
    const branding = await WhiteLabelConfig.findOne({ where: { orgId: user.orgId } });

    return { user: user.toSafeJSON(), tokens, branding };
  }

  async refresh(refreshToken) {
    let payload;
    try {
      payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      const err = new Error('Refresh token invalid or expired.');
      err.status = 401;
      throw err;
    }

    const user = await User.findByPk(payload.sub);
    if (!user || !user.isActive) {
      const err = new Error('User not found or inactive.');
      err.status = 401;
      throw err;
    }

    return this.issueTokens(user.id);
  }

  async me(userId) {
    const user = await User.findByPk(userId, {
      include: [{ model: Role, as: 'role' }],
    });
    if (!user) {
      const err = new Error('User not found.');
      err.status = 404;
      throw err;
    }
    const branding = await WhiteLabelConfig.findOne({ where: { orgId: user.orgId } });
    return { user: user.toSafeJSON(), branding };
  }
}

module.exports = new AuthService();
