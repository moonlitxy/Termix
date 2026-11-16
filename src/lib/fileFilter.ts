export interface FilterableItem {
  name: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function tokenToRegex(token: string): RegExp {
  const source = escapeRegex(token)
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "i");
}

function tokenMatcher(token: string): (name: string) => boolean {
  if (!token.includes("*") && !token.includes("?")) {
    const lowered = token.toLowerCase();
    return (name) => name.toLowerCase().includes(lowered);
  }
  const regex = tokenToRegex(token);
  return (name) => regex.test(name);
}

export function buildFilterMatcher(query: string): (name: string) => boolean {
  const trimmed = query.trim();
  if (!trimmed) return () => true;

  const alternatives = trimmed
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/).filter(Boolean).map(tokenMatcher));

  if (alternatives.length === 0) return () => true;
  return (name) =>
    alternatives.some((tokens) => tokens.every((matches) => matches(name)));
}

export function filterItems<T extends FilterableItem>(
  items: T[],
  query: string
): T[] {
  const matcher = buildFilterMatcher(query);
  return items.filter((item) => matcher(item.name));
}
