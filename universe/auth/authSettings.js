// Sign-up policy. The environment gives the defaults; an admin can change them in Settings without a redeploy.
export class AuthSettings {
  constructor({ storage, config }) {
    this.col = storage.collection('auth_settings');
    this.config = config;
  }
  async get() {
    const d = (await this.col.get('auth')) || {};
    const c = this.config.signup;
    return { signupEnabled: d.signupEnabled ?? c.enabled, signupRoleId: d.signupRoleId ?? c.roleId, signupAllowAi: d.signupAllowAi ?? c.allowAi };
  }
  async set(patch) {
    const cur = await this.col.get('auth');
    return cur ? this.col.update('auth', patch) : this.col.insert({ id: 'auth', ...patch });
  }
}
