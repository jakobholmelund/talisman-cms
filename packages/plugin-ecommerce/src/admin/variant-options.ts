export type ExistingOptionSet = {
  id: string;
  name: string;
  updatedAt: string | number;
  values: Array<{ value: string; image: string }>;
};
const unique = (values: string[]) => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
/** Only infer axes when the saved labels unambiguously match the group's structure. */
export function variantAxes(name: string, values: Array<{ value: string }>) {
  const names = name.split(" / ").map((v) => v.trim());
  const parts = values.map((v) => v.value.split(" / ").map((p) => p.trim()));
  const combined =
    names.length === 2 &&
    parts.length > 0 &&
    parts.every((p) => p.length === 2 && p.every(Boolean));
  return {
    combined,
    names: combined ? names : [names.length === 1 ? name : "Choice"],
    first: unique(
      combined ? parts.map((p) => p[0]) : values.map((v) => v.value),
    ),
    second: combined ? unique(parts.map((p) => p[1])) : [],
  };
}
export function additionalChoices(
  existing: ExistingOptionSet,
  first: string[],
  second: string[],
) {
  const axes = variantAxes(existing.name, existing.values),
    names = new Set(existing.values.map((v) => v.value.toLowerCase()));
  const a = unique([...axes.first, ...first]),
    b = unique([...axes.second, ...second]);
  const additions: Array<{ label: string; photoKey: string }> = [];
  // The 51st item signals that this batch is too large, without rendering an unbounded matrix.
  for (const value of a)
    for (const other of axes.combined ? b : [value]) {
      const choice = {
        label: axes.combined ? `${value} / ${other}` : value,
        photoKey: other,
      };
      if (!names.has(choice.label.toLowerCase())) additions.push(choice);
      if (additions.length > 50) return additions;
    }
  return additions;
}
export function inheritedPhotos(existing: ExistingOptionSet) {
  const axes = variantAxes(existing.name, existing.values),
    photos: Record<string, string> = {};
  for (const key of axes.combined ? axes.second : axes.first) {
    const matches = existing.values.filter(
      (v) => (axes.combined ? v.value.split(" / ")[1] : v.value) === key,
    );
    const images = new Set(matches.map((v) => v.image));
    if (images.size === 1) photos[key] = matches[0].image;
  }
  return photos;
}
