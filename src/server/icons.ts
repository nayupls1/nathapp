// Lucide icon names and search tags (from lucide-static, kept at the same
// version as lucide-solid, which renders them).
import tags from "lucide-static/tags.json" with { type: "json" };

const iconTags = tags as Record<string, string[]>;
const names = new Set(Object.keys(iconTags));

export const isIcon = (name: string) => names.has(name);

/** Ranks icons by how well their name and tags match the query words. */
export function searchIcons(query: string, limit = 30): string[] {
  const words = query.toLowerCase().split(/[\s,-]+/).filter(Boolean);
  if (!words.length) return [];
  const scored: [string, number][] = [];
  for (const [name, keywords] of Object.entries(iconTags)) {
    let score = 0;
    for (const word of words) {
      if (name === word) score += 10;
      else if (name.split("-").includes(word)) score += 6;
      else if (name.includes(word)) score += 3;
      if (keywords.some((k) => k === word)) score += 4;
      else if (keywords.some((k) => k.includes(word))) score += 1;
    }
    if (score) scored.push([name, score]);
  }
  return scored
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([name]) => name);
}
