/**
 * RSP-15: Installer-claim playbook (opt-in honeypot flow).
 *
 * A fake setup/install flow: the setup form carries the 5 core
 * fields, the install form the 2 core fields; a completed claim
 * registers the pair and an immediate verify grants. Poison guard:
 * a claim with an empty user or password still serves the Success
 * page but writes 0 registry rows, so garbage claims attach nothing.
 *
 * Measured in the RSP Step-0 lab: 20/20 seeded kit runs complete
 * setup, claim, immediate verify grant; poison guard 3/3.
 * Real kit completion rates stay CLAIM (no real kit ran in the lab).
 * Honeypot-surface only, advisory, low tier.
 */
export const RSP_SETUP_FIELDS = ["weblog_title", "user_name", "admin_password", "admin_password2", "admin_email"] as const;
export const RSP_INSTALL_FIELDS = ["dbname", "uname"] as const;

export interface RspInstaller {
  setupFormFields(): readonly string[];
  installFormFields(): readonly string[];
  claim(user: string, pass: string): { page: "success"; registered: boolean };
  verify(user: string, pass: string): boolean;
  registrySize(): number;
}

export function createRspInstaller(): RspInstaller {
  const registry = new Map<string, string>();
  return {
    setupFormFields: () => RSP_SETUP_FIELDS,
    installFormFields: () => RSP_INSTALL_FIELDS,
    claim(user, pass) {
      if (!user || !pass) return { page: "success", registered: false };
      registry.set(user, pass);
      return { page: "success", registered: true };
    },
    verify(user, pass) { return registry.get(user) === pass && !!user && !!pass; },
    registrySize: () => registry.size,
  };
}
