const clerkIssuerDomain =
  process.env.CLERK_JWT_ISSUER_DOMAIN ?? "https://example.clerk.accounts.dev";

const authConfig = {
  providers: [
    {
      domain: clerkIssuerDomain,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
