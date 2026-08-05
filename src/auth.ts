type ClerkSession = { getToken: () => Promise<string | null> };
type ClerkUser = { id: string; primaryEmailAddress?: { emailAddress?: string | null } | null };
type ClerkClient = {
  load: () => Promise<void>;
  openSignIn: (options: { afterSignInUrl: string; afterSignUpUrl: string }) => void;
  signOut: () => Promise<void>;
  session: ClerkSession | null;
  user: ClerkUser | null;
  addListener: (listener: () => void) => () => void;
};
declare global { interface Window { Clerk?: ClerkClient } }

type AuthConfig = { configured: boolean; publishableKey?: string; frontendApi?: string };
let clientPromise: Promise<ClerkClient | null> | null = null;

export async function loadClerk() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const config: AuthConfig = await fetch('/api/auth/config', { credentials: 'same-origin' }).then(async (response) => response.ok ? await response.json() as AuthConfig : { configured: false });
    if (!config.configured || !config.publishableKey || !config.frontendApi) return null;
    if (!window.Clerk) await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.async = true; script.crossOrigin = 'anonymous'; script.dataset.clerkPublishableKey = config.publishableKey;
      script.src = `${config.frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
      script.onload = () => resolve(); script.onerror = () => reject(new Error('clerk_load_failed')); document.head.append(script);
    });
    if (!window.Clerk) return null;
    await window.Clerk.load();
    return window.Clerk;
  })().catch(() => null);
  return clientPromise;
}

export async function authHeader(client: ClerkClient | null) {
  const token = await client?.session?.getToken();
  return token ? ({ Authorization: `Bearer ${token}` } as Record<string, string>) : {} as Record<string, string>;
}
export type { ClerkClient };
