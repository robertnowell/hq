import "./tokens.css";
import "./share/share.css";
import { headers } from "next/headers";
import { ClerkProvider, Show, UserButton } from "@clerk/nextjs";

export const metadata = {
  title: "Tranquility Knowledge Base",
  applicationName: "Tranquility Knowledge Base",
  appleWebApp: { capable: true, statusBarStyle: "default" as const, title: "Knowledge Base" },
};
export const viewport = { themeColor: "#1f1e1c" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // A document page draws its own bar, with the agent, the title and the two
  // things you can do with the page. A second bar above it would be chrome
  // about chrome on the one screen meant for reading.
  const here = (await headers()).get("x-hq-path") ?? "";
  const bare = here.startsWith("/d/") || here.startsWith("/share/");
  return (
    <ClerkProvider signInUrl="/sign-in" signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/"
      // Every Clerk surface (the sign-in card, the code step, the account
      // menu, the profile) wears the archive's tokens. Literal hex, as Clerk's
      // docs ask; the same values as tokens.css. Nothing here is purple.
      appearance={{
        variables: {
          colorPrimary: "#1f4f8f",
          colorBackground: "#fcfbf8",
          colorForeground: "#1f1e1c",
          colorMutedForeground: "#57534c",
          colorInput: "#fcfbf8",
          colorInputForeground: "#1f1e1c",
          colorNeutral: "#1f1e1c",
          colorDanger: "#8a3b2e",
          colorSuccess: "#4a5a2b",
          colorWarning: "#a8762a",
          fontFamily: "inherit",
          fontFamilyButtons: "inherit",
          fontSize: "15px",
          borderRadius: "10px",
          spacing: "0.95rem",
        },
        elements: {
          cardBox: { boxShadow: "none", border: "1px solid #ddd9cf" },
          card: { boxShadow: "none" },
          footer: { display: "none" },
          userButtonPopoverCard: { boxShadow: "0 8px 28px rgba(0,0,0,.18)", border: "1px solid #ddd9cf" },
          userButtonAvatarBox: { width: "26px", height: "26px" },
          avatarBox: { borderRadius: "50%" },
          formButtonPrimary: { backgroundImage: "none", backgroundColor: "#1f4f8f", boxShadow: "none" },
        },
      }}>
      <html lang="en">
        {/* ClerkProvider goes inside body, not around html. */}
        <body>
          {/* The nav is the signed-in app's; the front door has none. */}
          <Show when="signed-in">
            {!bare && <nav style={{ display: "flex", alignItems: "center", gap: ".75rem",
              padding: ".55rem 1rem", borderBottom: "1px solid var(--line)",
              background: "var(--paper)", position: "sticky", top: 0, zIndex: 10 }}>
              <a href="/" style={{ fontWeight: 650, color: "var(--heading)", textDecoration: "none" }}>Tranquility Knowledge Base</a>
              <span style={{ marginLeft: "auto", display: "flex", gap: ".6rem", alignItems: "center" }}>
                {/* The account menu is where a person looks for the things
                    that are theirs rather than the archive's, so the list of
                    connected Macs lives there rather than in the nav. */}
                <UserButton>
                  <UserButton.MenuItems>
                    <UserButton.Link label="Your Macs" href="/devices"
                      labelIcon={
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
                             fill="none" stroke="currentColor" strokeWidth="1.3">
                          <rect x="2" y="3" width="12" height="8" rx="1" />
                          <path d="M1 13.5h14" />
                        </svg>
                      } />
                    {/* Billing is the same kind of thing: theirs, not the
                        archive's. Beside Your Macs rather than in a settings
                        group nothing else needs yet. */}
                    <UserButton.Link label="Billing" href="/billing"
                      labelIcon={
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
                             fill="none" stroke="currentColor" strokeWidth="1.3">
                          <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
                          <path d="M1.5 6.5h13" />
                        </svg>
                      } />
                  </UserButton.MenuItems>
                </UserButton>
              </span>
            </nav>}
          </Show>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
