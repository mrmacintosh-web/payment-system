export function normalizeOrigin(value) {
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a complete HTTP or HTTPS address.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "PUBLIC_ORIGIN must contain only the scheme and hostname, with an optional port.",
    );
  }
  return url.origin;
}

export function codespacesOrigin(env = process.env) {
  const name = env.CODESPACE_NAME;
  if (!name || !/^[a-z\d]+(?:-[a-z\d]+)*$/i.test(name)) {
    throw new Error(
      "Run npm run codespaces inside your GitHub Codespace terminal.",
    );
  }
  const domain =
    env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev";
  if (
    !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(
      domain,
    )
  ) {
    throw new Error(
      "The Codespaces port-forwarding domain is not a valid hostname.",
    );
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a whole number between 1 and 65535.");
  }
  return `https://${name}-${port}.${domain}`.toLowerCase();
}
