/** Prototype routes carry their source selection into copied links and new profiles. */
export function prototypeNavigation(to: string): { href: string; clientSide: boolean } {
  // App routes use root-relative URLs. Other destinations keep native navigation.
  if (!to.startsWith("/") || to.startsWith("//")) return { href: to, clientSide: false };
  const origin = "https://prototype.invalid";
  const url = new URL(to, origin);
  if (
    url.origin !== origin ||
    url.searchParams.get("ui") === "api" ||
    ["/account", "/admin"].includes(url.pathname.replace(/\/+$/, ""))
  )
    return { href: to, clientSide: false };
  url.searchParams.set("ui", "prototype");
  return { href: `${url.pathname}${url.search}${url.hash}`, clientSide: true };
}
