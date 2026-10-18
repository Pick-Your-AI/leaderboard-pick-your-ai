/** Keep the explicitly synthetic source choice in URLs shared outside this browser. */
export function prototypeHref(href: string): string {
  const hashIndex = href.indexOf("#");
  const hash = hashIndex < 0 ? "" : href.slice(hashIndex);
  const address = hashIndex < 0 ? href : href.slice(0, hashIndex);
  const queryIndex = address.indexOf("?");
  const path = queryIndex < 0 ? address : address.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex < 0 ? "" : address.slice(queryIndex + 1));
  params.set("ui", "prototype");
  return `${path}?${params}${hash}`;
}
