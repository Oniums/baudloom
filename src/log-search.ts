export interface LogFilter {
  query: string;
  exclude: string;
  caseSensitive: boolean;
  onlyMatches: boolean;
}
export function searchTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .split("|")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ]
    .slice(0, 6)
    .map((t) => t.slice(0, 80));
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function compileSearch(filter: LogFilter) {
  const terms = searchTerms(filter.query);
  const excludes = searchTerms(filter.exclude);
  const flags = filter.caseSensitive ? "u" : "iu";
  const pattern = terms.length ? terms.map(escape).join("|") : "";
  const matcher = pattern ? new RegExp(pattern, flags) : null;
  const exclude = excludes.length
    ? new RegExp(excludes.map(escape).join("|"), flags)
    : null;
  return {
    active: Boolean(matcher),
    matches: (text: string) => Boolean(matcher?.test(text)),
    visible: (text: string) =>
      !exclude?.test(text) &&
      (!filter.onlyMatches || !matcher || matcher.test(text)),
    highlights: (text: string): { start: number; end: number }[] => {
      if (!pattern) return [];
      return Array.from(
        text.matchAll(new RegExp(pattern, flags + "g")),
        (m) => ({ start: m.index!, end: m.index! + m[0].length }),
      );
    },
  };
}
